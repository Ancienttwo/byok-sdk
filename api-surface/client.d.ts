// ==== @byok-sdk/client dist/adapters/claude/claude-adapter.d.ts ====
import { type RuntimeAdapter, type RuntimeDetectResult, type RuntimeVersionPolicy, type RuntimeAdapterPrepareInput, type RuntimeAdapterPrepareResult } from '../../types';
import { type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import { type ResolvedBin } from './resolve-bin';
import { type NativeInteractionHostOptions } from '../../native-interactions';
import { type SpawnFn } from './process-client';
export interface ClaudeAdapterOptions {
    /** Absolute product native asset directory; scoped to this adapter. */
    nativeAssetRoot?: string;
    /** The environment Claude and its MCP servers get (#1095). Default: the login-shell snapshot. */
    runtimeEnvironment?: RuntimeEnvironmentPolicy;
    /** Override bin resolution — tests substitute the fake-claude fixture script. */
    resolveBin?: () => ResolvedBin;
    /** Override process spawning — tests substitute a fake spawn. */
    spawnFn?: SpawnFn;
    /** Deadline for native interrupt ACK before owned-process termination fallback. */
    interruptTimeoutMs?: number;
    /** Local Host callbacks for native stdio requests; never enables remote boolean approvals. */
    nativeInteractions?: NativeInteractionHostOptions;
    /**
     * For an Agent task (`task.offer`), `excluded` starts Claude with
     * `--strict-mcp-config`, so only the task's and the SDK's MCP servers load,
     * and with a `--settings` file that excludes the `CLAUDE.md`,
     * `CLAUDE.local.md` and rules of the Claude config directory and of every
     * directory above the Agent home, and turns off Claude auto memory. The
     * user's settings, deny rules, hooks, model and env still apply. It affects
     * new sessions only: a resumed session keeps its history. Other tasks are
     * unchanged. Default `inherit`.
     */
    agentUserContext?: 'inherit' | 'excluded';
    /**
     * For an Agent task (`task.offer`), `disabled` starts Claude with
     * `--no-session-persistence`, so Claude does not save the session
     * transcript under `<config dir>/projects/`. Such a session cannot be
     * resumed: an Agent task that carries a `sessionRef` fails before Claude
     * starts. Follow-ups in the same task still work. Other tasks are
     * unchanged. Default `enabled`.
     */
    agentSessionPersistence?: 'enabled' | 'disabled';
    /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
    versionPolicy?: RuntimeVersionPolicy;
    /** Internal: `createDaemon` marks a `DaemonConfig.runtimes.<id>.versionPolicy` so the resolver reports its source. */
    versionPolicySource?: 'adapter-option' | 'daemon-config';
}
export declare class ClaudeAdapter implements RuntimeAdapter {
    private readonly options;
    readonly descriptor: import("..").RuntimeAdapterDescriptor;
    private readonly nativeOptions?;
    private readonly environmentPolicy;
    private readonly effectiveVersionPolicy;
    constructor(options?: ClaudeAdapterOptions);
    runtimeEnvironment(): Promise<RuntimeEnvironment>;
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
     * never reads `~/.claude` or any credential file itself. Pi's `auth check`
     * needs an explicit provider and a single-file product exposes no pi CLI,
     * so pi's equivalent (`../pi/auth-presence.ts`) checks env-var *names* and
     * the shape of its agent-dir login records instead.
     * A failed/unparseable probe (binary present but not logged in, a future
     * claude release changing this output shape, etc.) fails closed to
     * `false` — this never affects `present`, which is solely about whether
     * `--version` itself succeeded.
     */
    private probeAuthPresent;
    private resolveBin;
}
// ==== @byok-sdk/client dist/adapters/claude/events.d.ts ====
import type { McpEventIdentities } from '../../mcp/event-identity';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { MessageDraftDelta } from '../../types';
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
    readonly mcpIdentities?: McpEventIdentities;
}
export declare function createToolUseCorrelation(mcpIdentities?: McpEventIdentities): ToolUseCorrelation;
export interface MapClaudeMessageOptions {
    /** `ctx.workspaceDir` for the task — used only to compute a workspace-relative `name` for a possible `artifact` AgentEvent (see `tryBuildArtifactEvent`'s doc comment). */
    workspaceDir: string;
}
export interface MapClaudeMessageResult {
    events: Array<AgentEvent | MessageDraftDelta>;
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
 * Claude sends one `assistant` frame per content block, so one message can
 * span several frames that share `message.id`, and each text block is its
 * own `progress` event. This records which of those events continue a
 * message whose non-blank text already started, for
 * `Session.progressStartsMessage`. Text blocks in one frame always share a
 * message. Routine `system` frames and `stream_event` frames can arrive
 * mid-message and do not end it; any other frame does. A frame with no
 * string id never continues an earlier frame.
 *
 * Draft deltas (`stream_event`, from `--include-partial-messages`) carry the
 * message's `api_message_id`. The first non-blank delta of a new id starts a
 * draft message. Claude 2.1.302 sends a block's deltas before its `assistant`
 * frame, so the draft message starts before its `progress` does.
 */
export declare class AssistantMessageTracker {
    private readonly continuations;
    private open;
    private draft;
    observe(msg: ClaudeStreamMessage, events: ReadonlyArray<AgentEvent | MessageDraftDelta>): void;
    startsMessage(event: AgentEvent): boolean;
}
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
    nativeAssetRoot?: string;
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    spawnFn?: SpawnFn;
    /** Internal control-plane binding; control frames never enter the user/result event queue. */
    control?: {
        bind(write: (frame: Record<string, unknown>) => Promise<void>): void;
        receive(message: ClaudeStreamMessage): void;
        closed(): void;
    };
    /**
     * DI seam scoped to ADOPTION only (`../process-tree.ts`'s
     * `adoptOwnedProcessTree`), so the win32 job-object branch is exercisable
     * from POSIX. Disposal keeps `process.platform` as its own authority — this
     * must never silently reroute the taskkill sweep on a real host.
     */
    platform?: NodeJS.Platform;
    /** DI seam for the win32 job-object backstop; see `../win32-job-object.ts`. `release()` is called by this client's disposal once the tree is proved gone. */
    jobObject?: {
        assign(pid: number): Promise<{
            release(): void;
        }>;
    };
}
/**
 * NDJSON process transport for `claude -p --input-format stream-json
 * --output-format stream-json`.
 *
 * Structurally simpler than pi's `PiRpcClient` in one real way, and
 * different (not simpler) in another:
 *
 * - No user-turn request/response correlation. Optional native controls are
 *   correlated on a separate channel. pi's RPC mode replies to each command
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
    private exited;
    private transportError;
    private readonly pendingWrites;
    private readonly closedPromise;
    private resolveClosed;
    private disposalAttempt;
    /** Resolves once this tree is backstopped; rejection carries either completed disposal or an owned retry receipt. */
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
    writeUserMessage(text: string): Promise<void>;
    private writeFrame;
    /** Stop startup admission immediately, independently of the process-close receipt.
     * The stopped transport latch is checked again after adoption, so an abandoned
     * write cannot send a late prompt when delayed adoption eventually resolves.
     */
    abortStartup(error: Error): void;
    private onTransportError;
    /**
     * Resolves with claude's own `session_id` once its `system/init` frame
     * arrives (see this class's doc comment for why this exists at all).
     * Idempotent: once resolved, further calls resolve immediately with the
     * same id; if the process already closed before init ever arrived,
     * every call rejects with that same exit error.
     */
    waitForInit(): Promise<string>;
    /** Every non-control parsed stream-json line — `system/init` is consumed internally (see `waitForInit`) but is also forwarded here like any other frame, so routine-frame accounting in `ClaudeSession`'s mapper stays uniform. */
    get events(): AsyncIterable<ClaudeStreamMessage>;
    /** Local transport diagnostic retained when the process closes; consumers classify it at the session boundary. */
    get terminalError(): Error | undefined;
    /** The child process closed on its own (a `close` event, not a spawn error), and no adoption or transport failure outranked that exit; consumers classify it at the session boundary. */
    get processExited(): boolean;
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
     * session is published. If disposal fails, retain both failures and a retry
     * owner; adoption rejection alone is never a tree-quiescence receipt.
     */
    private adoptOwnedTree;
    private onData;
    private onLine;
    private onStderr;
    /** Mirrors pi's `buildExitError` exactly — stderr tail + unmapped-frame tally folded into one self-diagnosing message. */
    private buildExitError;
    private onClosed;
}
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
import { type NativeInteractionHostOptions } from '../../native-interactions';
import { type spawn as nodeSpawn } from 'node:child_process';
import { type RuntimeAdapter, type RuntimeDetectResult, type RuntimeVersionPolicy, type RuntimeAdapterPrepareInput, type RuntimeAdapterPrepareResult } from '../../types';
import { type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import { type ResolvedBin } from './resolve-bin';
/** A Codex `sandbox_mode`, or `inherit` to pass no override so the user's `config.toml` applies. */
export type CodexSandboxSetting = 'read-only' | 'workspace-write' | 'danger-full-access' | 'inherit';
/** Throws a TypeError unless `value` is a {@link CodexSandboxSetting}. */
export declare function assertCodexSandboxSetting(value: unknown, label: string): asserts value is CodexSandboxSetting;
export interface CodexAdapterOptions {
    /** Absolute product native asset directory; scoped to this adapter. */
    nativeAssetRoot?: string;
    /** The environment Codex and its MCP servers get (#1095). Default: the login-shell snapshot. */
    runtimeEnvironment?: RuntimeEnvironmentPolicy;
    /**
     * Codex sandbox for every session, as OAR's `OAR_CODEX_SANDBOX`. Default
     * `danger-full-access`: no human answers an approval prompt, so a sandbox
     * denial is a stalled task. `inherit` lets the user's own `config.toml` win.
     */
    sandbox?: CodexSandboxSetting;
    resolveBin?: () => ResolvedBin;
    spawnFn?: typeof nodeSpawn;
    maxRetainedBytes?: number;
    interruptTimeoutMs?: number;
    /**
     * Deadline in milliseconds for the session open, each prompt and each steer.
     * Default 30000. On expiry the session fails and the app-server is killed.
     */
    operationTimeoutMs?: number;
    /** Opt-in local Host UI; independent of the remote boolean approval lane. */
    nativeInteractions?: NativeInteractionHostOptions;
    /**
     * For an Agent task (`task.offer`), `excluded` gives the Codex
     * thread only the task's and the SDK's MCP servers. Before the thread
     * opens, the adapter reads Codex's effective configuration for the task cwd
     * (`config/read`), sets `enabled = false` on every other `mcp_servers`
     * entry, and turns off the `apps` (connectors) and `plugins` features for
     * the thread. Plugin exclusion also applies at app-server launch, before
     * startup plugin sync. The thread then has no plugins at all, not only no plugin
     * MCP servers. After the open it reads the thread's MCP server status
     * back, and the start fails if any other server is not disabled, or if a
     * user server has the name of a task or SDK server. The user's
     * `AGENTS.md`, login, model, sandbox setting and other configuration still
     * apply. It covers new and resumed threads. On a resume, Codex may start a
     * queued turn before the read-back: that turn already runs with the
     * overrides, and a failed read-back stops the app server. Other tasks are
     * unchanged. Default `inherit`.
     */
    agentUserMcpServers?: 'inherit' | 'excluded';
    /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
    versionPolicy?: RuntimeVersionPolicy;
    /** Internal: `createDaemon` marks a `DaemonConfig.runtimes.<id>.versionPolicy` so the resolver reports its source. */
    versionPolicySource?: 'adapter-option' | 'daemon-config';
}
/** Codex app-server is experimental and has no exec compatibility path. Version policy: `codex-version.ts`. */
export declare class CodexAdapter implements RuntimeAdapter {
    private readonly options;
    get descriptor(): import("..").RuntimeAdapterDescriptor;
    private readonly environmentPolicy;
    private readonly effectiveVersionPolicy;
    constructor(options?: CodexAdapterOptions);
    runtimeEnvironment(): Promise<RuntimeEnvironment>;
    detect(): Promise<RuntimeDetectResult>;
    prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult>;
    private start;
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
// ==== @byok-sdk/client dist/adapters/grok/grok-adapter.d.ts ====
import { type spawn as nodeSpawn } from 'node:child_process';
import { type RuntimeAdapter, type RuntimeAdapterPrepareInput, type RuntimeAdapterPrepareResult, type RuntimeDetectResult, type RuntimeVersionPolicy } from '../../types';
import { type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import type { ResolvedBin } from '../codex/resolve-bin';
export interface GrokAdapterOptions {
    /** Absolute product native asset directory; scoped to this adapter. */
    nativeAssetRoot?: string;
    /** The environment Grok and its MCP servers get (#1095). Default: the login-shell snapshot. */
    runtimeEnvironment?: RuntimeEnvironmentPolicy;
    /** Grok model id for every session (`session/set_model`). Absent: the user's Grok default. */
    model?: string;
    /**
     * `disabled` sets Grok's four Claude and Cursor `agents` and `rules`
     * variables to `0` on the Grok agent process. That turns off its scanning of
     * the named instruction files and rules directories under `~/.claude/` and
     * `~/.cursor/`, and the project `.claude/CLAUDE*.md`, `.claude/rules/` and
     * `.cursor/rules/`. Client-hosted terminal commands do not get the variables;
     * children that Grok starts itself, such as stdio MCP servers and hooks, may
     * inherit them. `$GROK_HOME/AGENTS.md`, `$GROK_HOME/rules/` and
     * `[paths] extra_rule_dirs` still load; Grok has no per-process switch for
     * them. Default `inherit`: the user's Grok settings apply.
     */
    compatInstructions?: 'inherit' | 'disabled';
    /**
     * For an Agent task (`task.offer`), `excluded` sets
     * `GROK_CLAUDE_MCPS_ENABLED`, `GROK_CURSOR_MCPS_ENABLED` and
     * `GROK_MANAGED_MCPS_ENABLED` to `0` on the Grok agent process, then runs
     * `grok inspect --json` in the task cwd with the same environment. The
     * start fails before the agent starts if inspect lists an MCP server that
     * is not disabled, or an enabled plugin that provides MCP servers, or if
     * inspect fails. Grok has no per-process switch for the servers of
     * `~/.grok/config.toml`, project `.grok/config.toml` and `.mcp.json`, or
     * plugins, so a user who has one enabled cannot run Agent tasks with this
     * option. Two sources are not detected: a server turned on while the
     * session runs (a config hot-reload, `/mcps` or `grok mcp enable`), and
     * managed MCP that an administrator pins on. Other tasks are unchanged.
     * Default `inherit`.
     */
    agentUserMcpServers?: 'inherit' | 'excluded';
    /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
    versionPolicy?: RuntimeVersionPolicy;
    /** Internal: `createDaemon` marks a `DaemonConfig.runtimes.<id>.versionPolicy` so the resolver reports its source. */
    versionPolicySource?: 'adapter-option' | 'daemon-config';
    resolveBin?: () => ResolvedBin;
    spawnFn?: typeof nodeSpawn;
    maxRetainedBytes?: number;
    interruptTimeoutMs?: number;
}
/**
 * Grok Build over ACP (`grok agent --always-approve --no-leader stdio`),
 * through the vendored OAR Grok profile. The SDK owns the agent process,
 * every terminal command Grok asks the client to run, the environment, the
 * record budget and the permission policy (requests are cancelled).
 *
 * `grok` is not a frozen wire runtime id, so a task reaches this adapter by
 * the custom-harness identity (`harnessId: 'grok'`). It takes no dispatch
 * selection; the model is the adapter's `model` option.
 */
export declare class GrokAdapter implements RuntimeAdapter {
    private readonly options;
    get descriptor(): import("..").RuntimeAdapterDescriptor;
    private readonly environmentPolicy;
    private readonly effectiveVersionPolicy;
    constructor(options?: GrokAdapterOptions);
    runtimeEnvironment(): Promise<RuntimeEnvironment>;
    /** Reads the version, probes ACP mode and looks for a login signal. It never opens a session or writes Grok's home. */
    detect(): Promise<RuntimeDetectResult>;
    prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult>;
    private start;
}
// ==== @byok-sdk/client dist/adapters/hermes/hermes-adapter.d.ts ====
import { type HermesByokLauncher } from './hermes-custody';
export type { HermesByokLauncher } from './hermes-custody';
import { spawn as nodeSpawn } from 'node:child_process';
import { type RuntimeAdapter, type RuntimeAdapterPrepareInput, type RuntimeAdapterPrepareResult, type RuntimeDetectResult, type RuntimeVersionPolicy } from '../../types';
import { type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import type { ResolvedBin } from '../codex/resolve-bin';
/** Provider choice written into each execution profile. Credentials stay in the environment. */
export interface HermesModelSelection {
    /** Hermes provider id, for example `openrouter`, `anthropic` or `custom`. */
    readonly provider: string;
    readonly model: string;
    /** Endpoint for an OpenAI-compatible `custom` provider. It must not carry credentials. */
    readonly baseUrl?: string;
    /** Name of the environment variable that holds the provider key. The value never enters the file. */
    readonly keyEnv?: string;
}
export interface HermesAdapterOptions {
    /** Absolute product native asset directory; scoped to this adapter. */
    nativeAssetRoot?: string;
    /** The environment Hermes and its MCP servers get (#1095). Default: the login-shell snapshot. A `byokLauncher` narrows it further. */
    runtimeEnvironment?: RuntimeEnvironmentPolicy;
    /**
     * Absolute path of the Hermes root that this SDK owns, for example under the
     * Host's store directory. Each execution runs in a fresh profile home below
     * it (`hermes-home.ts`). It must not be the user's Hermes home: `~/.hermes`,
     * or on Windows Hermes's default `%LOCALAPPDATA%\hermes`. Give each
     * Host process its own root. The first `detect()` on a new root waits while
     * Hermes builds its environment there.
     */
    home: string;
    /** Provider and model for every execution. Absent: Hermes picks a provider from the credentials in the environment. */
    model?: HermesModelSelection;
    /** Optional separate-process credential custody. Mutually exclusive with model; local Host profile selection never enters dispatchSelection. */
    byokLauncher?: HermesByokLauncher;
    resolveBin?: () => ResolvedBin;
    spawnFn?: typeof nodeSpawn;
    /** Deadline of the `detect()` ACP probe. Covers a first environment build in a new root. Default 180 s. */
    probeTimeoutMs?: number;
    /** Deadline for the owned gateway to report ready. Default 20 s. */
    gatewayReadyTimeoutMs?: number;
    /** Deadline for a cancelled turn to settle before the session fails. Default 1 s. */
    interruptTimeoutMs?: number;
    /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
    versionPolicy?: RuntimeVersionPolicy;
    /** Internal: `createDaemon` marks a `DaemonConfig.runtimes.<id>.versionPolicy` so the resolver reports its source. */
    versionPolicySource?: 'adapter-option' | 'daemon-config';
}
/**
 * Hermes Agent over ACP stdio (`hermes acp`). The `hermes acp` process is a
 * viewer: tools, MCP servers and the model loop run in a Hermes gateway. A
 * viewer that finds no gateway starts a detached one that outlives it, so the
 * adapter starts the gateway itself as an owned process tree, waits until the
 * gateway names that pid as ready, and only then starts the viewer. Both
 * trees are disposed at `close()`.
 */
export declare class HermesAdapter implements RuntimeAdapter {
    private readonly root;
    private readonly options;
    private readonly environmentPolicy;
    private readonly effectiveVersionPolicy;
    /** Profile homes of this adapter's open sessions; the stale-profile sweep keeps them. */
    private readonly liveHomes;
    get descriptor(): import("..").RuntimeAdapterDescriptor;
    constructor(options: HermesAdapterOptions);
    private command;
    runtimeEnvironment(): Promise<RuntimeEnvironment>;
    /** The custody launcher's lane is the platform baseline of the runtime environment. */
    private launchEnvironment;
    private rootEnvironment;
    /**
     * Prepares the SDK root, deletes profiles a dead Host left, runs
     * `hermes --version`, then one ACP `initialize` in a throwaway profile with
     * the same config and environment a turn gets. `initialize` does not reach
     * the gateway. `authPresent` is true when Hermes offers a provider auth
     * method, which it does only when that provider's credentials resolve. On a
     * new root the probe waits while Hermes builds its Python environment.
     */
    detect(signal?: AbortSignal): Promise<RuntimeDetectResult>;
    private probeAcp;
    /** Cheap admission, as Codex: the version probe only. The ACP probe and root build belong to `detect()`. */
    prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult>;
    private start;
}
// ==== @byok-sdk/client dist/adapters/hermes/hermes-custody.d.ts ====
import type { ProviderProfileBinding } from '@byok-sdk/protocol';
import type { RuntimeAdapterPrepareInput } from '../../types';
import type { HermesModelSelection } from './hermes-adapter';
type SelectedProfile = Omit<ProviderProfileBinding, 'requiredCapabilities'> & {
    readonly requiredCapabilities: readonly ProviderProfileBinding['requiredCapabilities'][number][];
};
export interface HermesByokLauncher {
    /** Dedicated Host executable running keys.runHermesProviderLauncher; not the Hermes executable. */
    readonly command: string;
    readonly args?: readonly string[];
    readonly profileDbPath: string;
    /** Host local authority, called before claim. Returns exact non-secret binding, never a credential. */
    readonly selectProfile: (offer: RuntimeAdapterPrepareInput['offer']) => SelectedProfile | Promise<SelectedProfile>;
}
export interface PreparedHermesCustody {
    binding: ProviderProfileBinding;
    model: HermesModelSelection;
}
export declare function ownHermesLauncher(value: HermesByokLauncher): HermesByokLauncher;
export declare function hermesCustodyArgs(launcher: HermesByokLauncher, binding: ProviderProfileBinding, launch?: {
    hermesBin: string;
    home: string;
    role: 'gateway' | 'viewer';
}): string[];
export declare function prepareHermesCustody(launcher: HermesByokLauncher, offer: RuntimeAdapterPrepareInput['offer']): Promise<PreparedHermesCustody>;
export {};
// ==== @byok-sdk/client dist/adapters/index.d.ts ====
export type { RuntimeAdapter, RuntimeAdapterDescriptor, RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult, RuntimeAdapterRejectedOperation, RuntimeAdapterPreparedOperation, PreparedRuntimeOperation, RuntimeSessionLease, RuntimeOperationManifest, RuntimeOperationStartInput, RuntimeCapabilities, RuntimeDetectResult, RuntimeDetectionAdvisory, RuntimeDetectionRefusalReason, } from '../types';
export { isWireRuntimeId, observeRuntimeDetection, projectRuntimeObservation, taskRuntimeTarget, validateRuntimeDetectResult } from '../runtime-detection';
export type { RuntimeObservation } from '../runtime-detection';
export { RuntimeDisposalFailure, RuntimeExecutionFailure, RuntimeStartupDisposalFailure } from '../runtime-failure';
export type { RuntimeDisposalFailureInput, RuntimeDisposalStage, RuntimeExecutionFailureInput, RuntimeFailureCategory, RuntimeFailurePhase, RuntimeRetryDisposition, } from '../runtime-failure';
export { PiAdapter } from './pi/pi-adapter';
export type { PiAdapterOptions, PiByokLauncherConfig } from './pi/pi-adapter';
export { PI_PACKAGE_NAME } from './pi/resolve-bin';
export { ClaudeAdapter } from './claude/claude-adapter';
export type { ClaudeAdapterOptions } from './claude/claude-adapter';
export { CodexAdapter } from './codex/codex-adapter';
export type { CodexAdapterOptions, CodexSandboxSetting } from './codex/codex-adapter';
export { GrokAdapter } from './grok/grok-adapter';
export type { GrokAdapterOptions } from './grok/grok-adapter';
export { HermesAdapter } from './hermes/hermes-adapter';
export type { HermesAdapterOptions, HermesModelSelection, HermesByokLauncher } from './hermes/hermes-adapter';
export { NativeInteractionController, NativeInteractionError } from '../native-interactions';
export type { NativeApprovalDecision, NativeInteractionCapabilities, NativeInteractionIdentity, NativeQuestion, NativeQuestionAnswer, NativeInteractionInput, NativeInteractionRequest, NativeInteractionResponse, NativeInteractionReceipt, NativeInteractionEndReason, NativeInteractionChannel, NativeInteractionOptions, NativeInteractionHostOptions, NativeInteractionTransport, NativeInteractionErrorCode, } from '../native-interactions';
export { buildRuntimeEnvironment, RuntimeEnvironmentUnavailableError } from '../runtime/environment';
export type { RuntimeEnvironment, RuntimeEnvironmentConflictRule, RuntimeEnvironmentPolicy, RuntimeEnvironmentRemovalRule, RuntimeEnvironmentReport, RuntimeEnvironmentSource } from '../runtime/environment';
export { createExecutionScratch, ScratchRootPathError } from '../daemon/retention/scratch';
export type { ExecutionScratch } from '../daemon/retention/scratch';
// ==== @byok-sdk/client dist/adapters/packaging.d.ts ====
import { type SdkPackagingFormat } from '../sdk-native-assets';
export type { SdkPackagingFormat } from '../sdk-native-assets';
/** The part of an esbuild build that this plugin reads and sets. Declared here so esbuild is not an SDK dependency. */
export interface SdkPackagingBuild {
    readonly initialOptions: {
        bundle?: boolean;
        platform?: string;
        format?: string;
        define?: Record<string, string>;
        banner?: Record<string, string>;
        logOverride?: Record<string, string>;
    };
    onEnd(callback: (result: {
        readonly warnings: readonly SdkPackagingMessage[];
    }) => {
        errors: SdkPackagingMessage[];
    } | undefined): void;
}
/** The part of an esbuild message that this plugin reads and reports. */
export interface SdkPackagingMessage {
    readonly id?: string;
    readonly text: string;
    readonly location?: {
        readonly file: string;
        readonly line?: number;
        readonly column?: number;
        readonly lineText?: string;
    } | null;
}
export interface SdkBundleImportMetaExemption {
    /** npm package name, as installed under `node_modules`. */
    readonly package: string;
    /** File within the package, `/`-separated. */
    readonly file: string;
    /** Why the empty `import.meta` is not reached, or what a bundle loses. */
    readonly reason: string;
}
/**
 * The reviewed third-party files whose `import.meta` esbuild empties in a CommonJS bundle of the SDK. Every other
 * empty `import.meta`, in any file, fails the build. The SDK's own files are never exempt. A test bundles the embedded
 * Host and requires exactly these files to warn, so an entry a dependency update made stale fails too.
 */
export declare const sdkBundleImportMetaExemptions: readonly SdkBundleImportMetaExemption[];
/** Structurally an esbuild `Plugin`: pass it in `plugins`. */
export interface SdkPackagingPlugin {
    readonly name: string;
    setup(build: SdkPackagingBuild): void;
}
export interface ByokSdkPackagingOptions {
    readonly format: SdkPackagingFormat;
}
/**
 * The esbuild plugin for a single-file Host bundle (`sdkPackagingFormats`). `sea` is the CommonJS bundle a Node SEA
 * embeds. The build must be a `platform: 'node'` bundle in the format's esbuild output format.
 *
 * - ESM: a module-scoped `require`, which the CommonJS dependencies of the bundled Pi host need for Node built-ins.
 * - CommonJS: `import.meta.url` is the bundle's own file URL (`__filename`; the executable inside a SEA). It is the only
 *   `import.meta` property SDK code reads, so a Host must not define it too.
 * - Every format: an empty `import.meta` is a build error in any file, SDK included, except the reviewed third-party
 *   sites in `sdkBundleImportMetaExemptions`, which stay visible as warnings. esbuild already rejects top-level `await`
 *   in CommonJS output. Neither is ever left for the bundle to hit at run time.
 */
export declare function byokSdkPackaging(options: ByokSdkPackagingOptions): SdkPackagingPlugin;
export interface CopySdkPackagingAssetsOptions {
    /** A new or empty directory that ships beside the product bundle or executable. */
    readonly outDir: string;
    readonly platform: 'darwin' | 'linux' | 'win32';
    readonly arch: 'x64' | 'arm64';
}
/** Directories relative to `outDir`, for the product's daemon configuration and environment. */
export interface SdkPackagingAssets {
    /** Every written file, relative to `outDir`, sorted. */
    readonly files: readonly string[];
    /** `PI_PACKAGE_DIR` for the Pi host. */
    readonly piPackageDir: string;
    /** `DaemonConfig.nativeAssetRoot`; Windows x64 only. */
    readonly nativeAssetRoot?: string;
    /** `DaemonConfig.agentMemoryHelperAssetRoot`; macOS and Windows x64. Linux memory needs no helper. */
    readonly agentMemoryHelperAssetRoot?: string;
}
/**
 * Build-time copy of every SDK file a single-file Host ships for one target, in `sdkPackagingAssetLayout`: the Pi
 * runtime assets, and the native assets of the platforms that have them (`sdkNativeAssetTargets`). It composes
 * `copyPiRuntimeAssets` and `copySdkNativeAssets`, with their integrity checks; the Windows target downloads the
 * integrity-pinned koffi archive.
 */
export declare function copySdkPackagingAssets(options: CopySdkPackagingAssetsOptions): Promise<SdkPackagingAssets>;
// ==== @byok-sdk/client dist/adapters/pi/pi-adapter.d.ts ====
import { type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import type { ProviderProfileBinding } from '@byok-sdk/protocol';
import { type RuntimeAdapter, type RuntimeDetectResult, type RuntimeVersionPolicy, type RuntimeAdapterPrepareInput, type RuntimeAdapterPrepareResult } from '../../types';
import { type SdkHelperHostConfig } from '../../sdk-reserved-helper-host';
import { type ResolvedBin } from './resolve-bin';
import { type SpawnFn } from './rpc-client';
/** Pi launch options; execution scratch and replica authority come from start input. */
export interface PiAdapterOptions {
    /** Agent tasks only: exclude user resources/settings while retaining Pi model/auth stores. Default inherit. Not a tool permission. */
    agentUserContext?: 'inherit' | 'excluded';
    /** Agent RPC tasks only: explicit absolute local skill files/directories, including with excluded context. Default []. */
    agentSkillPaths?: readonly string[];
    /** Agent RPC tasks only: trusted executable local extensions, including with excluded context. Default []. */
    agentExtensionPaths?: readonly string[];
    /** Absolute product native asset directory; scoped to this adapter. */
    nativeAssetRoot?: string;
    /** The environment Pi and its MCP servers get (#1095). Default: the login-shell snapshot. */
    runtimeEnvironment?: RuntimeEnvironmentPolicy;
    /** Opt-in ordinary, lease-bound durable worker. */
    durablePi?: boolean;
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
    /**
     * Re-enter the product's single-file/SEA executable for every Pi launch,
     * as `<executable> [<entry>] __byok_sdk_helper <pi-rpc|pi-prepared|pi-durable>`.
     * The product bundles Pi, so no installed Pi package is resolved.
     */
    sdkHelperHost?: SdkHelperHostConfig;
    /** Admission-time exact local profile check. Tests may replace the process boundary. */
    validateProviderProfileBinding?: (binding: ProviderProfileBinding, launcher: PiByokLauncherConfig) => Promise<void>;
    /** A complete Host version policy that replaces the descriptor default wholesale (#1103). */
    versionPolicy?: RuntimeVersionPolicy;
    /** Internal: `createDaemon` marks a `DaemonConfig.runtimes.<id>.versionPolicy` so the resolver reports its source. */
    versionPolicySource?: 'adapter-option' | 'daemon-config';
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
    private readonly agentResources;
    private readonly environmentPolicy;
    private readonly effectiveVersionPolicy;
    constructor(options?: PiAdapterOptions);
    runtimeEnvironment(): Promise<RuntimeEnvironment>;
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
 * This constant is both the resolution specifier and the installed identity's
 * name: `packages/client/package.json` pins it to one exact official version
 * (`byok.piRuntimePin` projects that dependency), and the manifest on disk must
 * be the official package at exactly that version.
 */
export declare const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export interface ResolvedBin {
    command: string;
    source: 'package' | 'env';
}
/** The exact package `PI_PACKAGE_NAME` must resolve to on disk. */
export interface PiRuntimeIdentity {
    /** Manifest `name` of the installed runtime: always {@link PI_PACKAGE_NAME}. */
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
 * The installed root of the pinned official Pi package. Its manifest name and
 * version must both equal the client pin; a mismatch fails closed instead of
 * returning an unverified runtime. `remedy` ends every refusal.
 *
 * Deliberately does NOT use `createRequire(...).resolve()`: this package is
 * pure ESM with no `require` export condition (`exports["."]` only offers
 * `import`), so CJS-style resolution fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. It does not use `import.meta.resolve`
 * either, which a CommonJS bundle does not have. It locates the package
 * directory itself; the root is the same one ESM resolution reaches.
 */
export declare function resolvePinnedPiPackage(remedy: string): {
    readonly dir: string;
    readonly identity: PiRuntimeIdentity;
    readonly bin: string | Record<string, string> | undefined;
};
/**
 * Resolve the pi CLI executable from the required package installed alongside
 * `@byok-sdk/client`. There is intentionally no automatic PATH fallback: a
 * global `pi` would create a second, unversioned authority for this contract.
 *
 * `BYOK_PI_BIN` overrides the package for tests and e2e runs only.
 * `PiAdapterOptions.resolveBin` is the seam for in-process tests.
 * The `byok-agent` CLI constructs `new PiAdapter()` with no options, so e2e
 * runs use the env override to select a fake-pi fixture.
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
    nativeAssetRoot?: string;
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
    /** DI seam for the win32 job-object backstop; see `../win32-job-object.ts`. `release()` is called by this client's disposal once the tree is proved gone. */
    jobObject?: {
        assign(pid: number): Promise<{
            release(): void;
        }>;
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
    private exited;
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
    /** Stdout lines that were not a JSON object, plus a last line the process never terminated — see `onLine` and `onClosed`. */
    private decodeDroppedLines;
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
    /** The child process closed on its own (a `close` event, not a spawn error), and no adoption failure outranked that exit; consumers classify it at the session boundary. */
    get processExited(): boolean;
    /**
     * Stdout frames this client dropped because it could not decode them: a
     * complete line that is not a JSON object, or the unterminated last line of
     * a process that ended mid-write. Pi writes every RPC frame as one JSON
     * object and LF, and its stdout guard sends ordinary writes to stderr, so
     * there is no expected noise to exclude (Octop T0).
     */
    get decodeDropped(): number;
    /** Total of the frames `recordUnmappedFrame` counted, across every type. */
    get unmappedFrames(): number;
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
// ==== @byok-sdk/client dist/adapters/pi/runtime-assets.d.ts ====
/**
 * How a single-file product runs Pi. `interpreter+bundle`: an interpreter
 * (Node or Bun) runs the product's JS bundle. `compiled-executable`: a
 * Bun-compiled executable. Pi looks for its files at different paths in each.
 */
export type PiRuntimeAssetForm = 'interpreter+bundle' | 'compiled-executable';
export interface CopyPiRuntimeAssetsOptions {
    /** The product's Pi asset root. It must not exist or must be empty. */
    readonly outDir: string;
    readonly form: PiRuntimeAssetForm;
}
/**
 * Create the Pi asset root of a single-file product from the installed
 * `@byok-sdk/client` and its pinned official Pi package. Run it in the
 * product build, then ship `outDir` with the product and name it in
 * `PI_PACKAGE_DIR` (a Bun-compiled executable may keep it beside itself).
 *
 * The Pi package must be the exact official pin. The Pi export resources must
 * match their recorded SHA-256 digests, and the SDK todo locale assets must
 * match their build manifest; a mismatch fails closed. Returns the written
 * file paths, relative to `outDir`, in sorted order.
 */
export declare function copyPiRuntimeAssets(options: CopyPiRuntimeAssetsOptions): Promise<readonly string[]>;
// ==== @byok-sdk/client dist/adapters/pi/runtime-launch.d.ts ====
import type { ExecutionScratch } from '../../daemon/retention/scratch';
/** The SDK-owned Pi entry a launch starts. */
export type PiRuntimeLaunchKind = 'pi-rpc' | 'pi-prepared' | 'pi-durable';
export interface PiRuntimeLaunchResources {
    readonly scratch: ExecutionScratch;
    readonly kind: PiRuntimeLaunchKind;
    /** The interpreter, or the executable itself. */
    readonly command: string;
    /** The script the interpreter runs. Absent for an executable. */
    readonly entry?: string;
    /**
     * The fixed argv after the entry. A single-file product re-enters itself
     * with `__byok_sdk_helper <kind>`; the installed package needs none.
     */
    readonly fixedArgs: readonly string[];
    /** The real path of the session cwd. The Pi process starts in it, as in OAR. */
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly sessionCwd: string;
    readonly credentialSource: 'pi-auth-store' | 'keys-profile';
    /**
     * The fresh 0700 directory the keys launcher writes the provider projection
     * into. Present exactly when `credentialSource` is `keys-profile`.
     */
    readonly projectionDir?: string;
    /** A single client-owned cleanup authority, idempotent across declined/start/terminal paths. */
    release(): Promise<void>;
}
export declare function resolvePiRuntimeLaunch(options: {
    kind: PiRuntimeLaunchKind;
    sessionCwd: string;
    env: Readonly<Record<string, string | undefined>>;
    scratch: ExecutionScratch;
    keysSessionDir?: string;
    /** The SDK Pi entry for this kind. */
    resolveInvocation: () => {
        command: string;
        entry?: string;
        fixedArgs?: readonly string[];
    };
}): Promise<PiRuntimeLaunchResources>;
/**
 * The spawn command of one Pi host launch. Without a launcher the host starts
 * directly. With one, the keys launcher starts the host and writes the
 * provider projection into the launch's projection directory.
 */
export declare function piLaunchCommand(launch: PiRuntimeLaunchResources, runtimeEntry: 'pi-rpc' | 'pi-prepared' | 'pi-durable', configDigest: string, hostArgs: readonly string[], launcher: {
    readonly command: string;
    readonly args: readonly string[];
    readonly profileArgs: readonly string[];
} | undefined): {
    command: string;
    args: string[];
};
// ==== @byok-sdk/client dist/agent-home-readers.d.ts ====
import { type TerminalAgentHomeMemoryChange } from '@byok-sdk/protocol';
/**
 * How one Agent Attempt uses its home. The wire carries only
 * `homeAccess: 'memory-reader'`; an absent value is the writer.
 */
export type AgentHomeAccessMode = 'memory-writer' | 'memory-reader';
/** SDK-owned parent of reader run directories, under the home's `.byok/`. */
export declare const AGENT_HOME_READER_RUNS_DIRECTORY = "runs";
/** Retention keeps at most this many reader run directories per home. */
export declare const AGENT_HOME_READER_RUN_MAX_RETAINED = 32;
/** Retention removes an unprotected reader run directory older than this. */
export declare const AGENT_HOME_READER_RUN_MAX_AGE_MS: number;
/**
 * Whether a taskId can name a reader run directory. A taskId is any
 * non-empty wire string, so the SDK accepts only one plain path segment.
 */
export declare function isReaderRunName(taskId: string): boolean;
/** Relative path (with `/` separators) -> content fingerprint of one memory file. */
export type AgentHomeMemoryDigest = ReadonlyMap<string, string>;
/**
 * Fingerprints `MEMORY.md` and every entry under `notes/`, bounded by
 * {@link AGENT_HOME_MEMORY_DIGEST_MAX_FILES} entries (directories count) and
 * {@link AGENT_HOME_MEMORY_DIGEST_MAX_BYTES} bytes. It never follows a
 * symbolic link: a link is fingerprinted by its target text. A file is opened
 * without following a link and without blocking, must be a regular file, and
 * is read only up to the remaining byte budget. Returns `undefined` when a
 * bound is exceeded, an entry is not a directory, regular file or link, or a
 * read fails; the caller then reports `unmeasured`.
 */
export declare function digestAgentHomeMemory(home: string): Promise<AgentHomeMemoryDigest | undefined>;
/**
 * Compares the reader's start and terminal digests. `writerOverlapped` is
 * true when a writer Attempt of the same home was active at any time
 * during the reader.
 */
export declare function compareAgentHomeMemory(before: AgentHomeMemoryDigest | undefined, after: AgentHomeMemoryDigest | undefined, writerOverlapped: boolean): TerminalAgentHomeMemoryChange;
// ==== @byok-sdk/client dist/agent-home.d.ts ====
import { type AgentHomeProjectionOutcome, type AgentHomeProjectionPayload, type AgentRef, type TerminalAgentHomeProjection } from '@byok-sdk/protocol';
import { type AgentHomeAccessMode } from './agent-home-readers';
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
/**
 * A resumed reader session's run directory is gone, for example after
 * retention removed it. The SDK does not create a new directory for an old
 * session, so the offer is declined without retry.
 */
export declare class AgentHomeReaderRunMissingError extends AgentHomeError {
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
    /**
     * Canonical absolute Agent home. It is the runtime cwd of a writer Attempt;
     * a memory-reader Attempt runs in its run directory under this home.
     */
    readonly homeDir: string;
    readonly canonicalHome: string;
}
export interface AgentHomeProjectionInput extends AgentHomeResolution {
    /** Runtime cwd: the home for a writer, the run directory for a memory-reader. */
    readonly cwd: string;
}
export interface AgentHomeProjectionApplyInput extends AgentHomeProjectionInput {
    readonly requestId: string;
    readonly projectionHash: string;
    readonly projection: unknown;
    /**
     * Atomically replace one file at the root of the canonical Agent home with
     * `body`. A string body is written as UTF-8. `name` is one portable file
     * name: no path separator, no `:<>"|?*`, no control character, no trailing
     * dot or space, no Windows device name and no `<file>.<pid>-<n>.tmp` temp
     * file name. `.byok`, `MEMORY.md` and `notes` belong to the SDK and are
     * refused in any letter case.
     *
     * The call is valid only while this hook runs. The SDK waits for every call
     * before it records the projection, and refuses a call after the hook
     * settles. A write that fails also fails the projection, even when the hook
     * catches the error. A refused call writes nothing.
     *
     * Each call is atomic for its own file only. There is no transaction over
     * several files. After a process crash, the file has its old bytes or its
     * new bytes, never a mix. The call replaces the directory entry of `name`,
     * so it never writes through a link at `name`. On POSIX, the file has mode
     * 0600, and a successful return means that the file and its directory are
     * flushed to storage. On Windows, a successful return means only that the
     * file is flushed. Node has no directory flush on Windows, so after an OS
     * crash or a power loss the new name can be lost while the SDK projection
     * record stays. Only a delivery of the same revision and hash calls this
     * hook again and repairs the file. A process crash can leave a
     * `<name>.<pid>-<n>.tmp` file in the home. Before it writes, a call removes
     * each such file of the same name whose process has ended. The SDK owns
     * file names of that form.
     */
    readonly writeHomeFile: (name: string, body: string | Uint8Array) => Promise<void>;
}
/**
 * Optional downstream projection hook. The SDK supplies the canonical home;
 * the host supplies opaque, redacted product content and never joins
 * `agents/<agentId>` itself. The SDK does not parse the projected content.
 */
export interface AgentHomeProjection {
    /**
     * Optional creation/task-time host preparation retained as a distinct
     * lifecycle. It runs at every Attempt start under that Attempt's execution
     * lease. For a memory-reader Attempt, `cwd` is the run directory, and the
     * one writer of the home can be running at the same time, so a hook that
     * changes home files must tolerate a concurrent writer.
     */
    prepare?(input: AgentHomeProjectionInput): void | Promise<void>;
    /**
     * Task-free opaque desired-state consumer. It must atomically and
     * idempotently ensure its own durable bytes because exact revision/hash
     * requests may replay after local derived-file loss or transport failure.
     * `input.writeHomeFile` writes one file at the home root in this way.
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
    /**
     * `memory-writer` runs in the canonical home. `memory-reader` runs in its
     * own run directory, `<home>/.byok/runs/<name>`, which is then `cwd`.
     */
    readonly homeAccess: AgentHomeAccessMode;
    /** Fresh tasks are task-keyed until the runtime returns its durable session id. */
    bindSession(sessionRef: string): Promise<void>;
    /**
     * Whether a writer Attempt of the same home was active at any time while
     * this lease was held. Meaningful for a reader lease only.
     */
    writerOverlapped(): boolean;
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
    /** Configured root, for read-only maintenance discovery; does not materialize a home. */
    hostRootInput(): string;
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
/** `storeDir` must come from `DeviceStore.resolveDir`, so every alias of a store yields one owner. */
export declare function stableAgentHomeOwnerId(storeDir: string, productId: string): string;
/** One-writer lease backed by both a process registry and an exclusive marker. */
export declare class AgentHomeLeaseManager {
    private static readonly held;
    private readonly ownerId;
    constructor(options?: {
        ownerId?: string;
    });
    acquire(resolution: AgentHomeResolution): Promise<AgentHomeLease>;
    /** No AgentRef is minted: this lease owns filesystem mutation, not a product profile. */
    acquireMaintenance(agentsRoot: string, canonicalHome: string): Promise<{
        release(): Promise<void>;
    }>;
    private linkLeaseMarker;
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
    /** Effective `DaemonConfig.maxConcurrentReaderAttemptsPerAgentHome`. A home always has at most one writer. */
    maxConcurrentReaderAttemptsPerAgentHome: number;
    /** Canonical Agent homes this daemon currently holds at least one execution lease in. */
    activeHomes: number;
    /** Total Attempts, writers and readers, holding an execution lease across those homes. */
    activeAttempts: number;
    /** The `memory-reader` Attempts among `activeAttempts`. */
    activeReaderAttempts: number;
}
/** The run directory of one reader Attempt: a direct child of `<home>/.byok/runs/`. */
export declare function agentHomeReaderRunDirectory(canonicalHome: string, name: string): string;
/**
 * Session-scoped execution leases share one process-owned home marker. The
 * marker remains until the final session exits, so relocation still sees the
 * Agent home as active, while different sessions no longer exclude each other.
 *
 * This layer counts; it does not cap. How many Attempts may be active in one
 * canonical home is a daemon admission decision made once, before any side
 * effect, by `TaskRunner.handleOffer`'s per-home busy gate reading
 * {@link AgentHomeExecutionLeaseManager.activeAttemptCount} per access mode:
 * one writer, and `DaemonConfig.maxConcurrentReaderAttemptsPerAgentHome`
 * readers (default 4).
 *
 * A writer lease's cwd is the canonical home. A reader lease's cwd is its own
 * run directory, which the caller names. A reader lease records whether a
 * writer lease of the same home overlapped it, for memory-change evidence.
 */
export declare class AgentHomeExecutionLeaseManager {
    private readonly manager;
    private static readonly groups;
    private static readonly queues;
    constructor(manager: AgentHomeLeaseManager);
    acquire(resolution: AgentHomeResolution, input: {
        readonly taskId: string;
        readonly sessionRef?: string;
        readonly homeAccess?: AgentHomeAccessMode;
        /** Required for a reader: its run directory under this home. */
        readonly cwd?: string;
    }): Promise<AgentHomeExecutionLease>;
    /**
     * WP0: Attempts of one access mode currently holding an execution lease on
     * this exact canonical home, across every lane and every session. This is
     * the number the daemon's admission gate reads before any side effect — see
     * `TaskRunner.handleOffer`'s per-home busy gate.
     *
     * Derived from the one lease registry above rather than a second tally, so
     * it inherits the lease lifecycle exactly: an entry appears at `acquire()`,
     * survives `bindSession()` (which rekeys in place), and disappears only at
     * `release()`, which the task runner calls after the attempt is terminal
     * AND `Session.close()` resolved. A failed disposal never reaches
     * `release()`, so the slot stays held — fail closed, the same posture as
     * `runtime-disposal-failed`. Because `release()` comes after the semantic
     * terminal is published, the admission gate may wait once for this
     * runner's already-finishing Attempts of the same home to settle and then
     * read this count again (#476); the count itself stays the only authority
     * on whether a slot is free. Crash residue: a restarted daemon starts with
     * an empty registry and reclaims the on-disk marker only under the same
     * stable owner identity (`linkLeaseMarker`), after its start ended the
     * crashed run's owned runtime processes (`OwnedProcessLedger.reconcile`).
     *
     * Counted regardless of which lease manager owns the group: the invariant
     * being protected is the filesystem path (`MEMORY.md`, `notes/`, `.git`),
     * not the owner identity.
     */
    activeAttemptCount(canonicalHome: string, homeAccess: AgentHomeAccessMode): number;
    /** How many active reader leases of this home use `cwd` as their run directory. */
    activeReaderRunHolders(canonicalHome: string, cwd: string): number;
    /** Run directories that active reader Attempts of this home use; retention never removes them. */
    activeReaderRunDirectories(canonicalHome: string): ReadonlySet<string>;
    /**
     * Counts-only readback for daemon/control status. Scoped to this manager's
     * own leases, so the number describes this daemon rather than every home
     * any manager in the process happens to hold. Never exposes a home path.
     */
    activeAttemptSummary(): {
        readonly homes: number;
        readonly attempts: number;
        readonly readerAttempts: number;
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
    /** Maintenance uses the base writer registry and holds its root gate until work settles. */
    withIdleHomeLease(agentId: string, work: (home: string) => Promise<void>): Promise<boolean>;
    /** Resolve and lease without applying downstream projection side effects. */
    acquire(agentRef: AgentRef): Promise<AgentHomeBinding>;
    /**
     * A writer runs in the canonical home. A fresh reader runs in
     * `<home>/.byok/runs/<taskId>/`. A resumed reader passes the run directory
     * its session handoff recorded, as `runDirectory`.
     */
    acquireExecution(agentRef: AgentRef, input: {
        readonly taskId: string;
        readonly sessionRef?: string;
        readonly homeAccess?: AgentHomeAccessMode;
        readonly runDirectory?: string;
    }): Promise<AgentHomeExecutionBinding>;
    /**
     * Prepares the run directory of a reader lease under the home's execution
     * queue. A fresh reader first applies retention, then creates its own
     * directory. A redelivered offer can find the directory that an earlier
     * start of the same task created before a crash: the start reuses it when
     * it is a real, empty directory that no other active reader holds, and
     * throws {@link AgentHomeBusyError} otherwise, so two tasks never share a
     * directory. A resumed reader requires its recorded directory to exist and
     * throws {@link AgentHomeReaderRunMissingError} when it does not.
     *
     * Reader directories remain after the terminal. The unified sweeper prunes
     * only under an idle home base lease and preserves recent handoff references.
     */
    prepareReaderRun(binding: AgentHomeExecutionBinding, input: {
        readonly fresh: boolean;
    }): Promise<void>;
    /** A fresh reader may reuse only a real, empty run directory that no other active reader holds. */
    private assertReusableReaderRun;
    /** Initialize only after any requested session exact-match has succeeded. */
    initialize(binding: AgentHomeBinding): Promise<void>;
    /**
     * Task-free initialization for a caller already holding `binding.lease`:
     * only the SDK-owned home skeleton (`notes/`, `MEMORY.md`), exactly as
     * `project()` ensures it, and never the downstream `projection.prepare`
     * lifecycle, which belongs to task/creation time.
     */
    initializeTaskFree(binding: AgentHomeBinding): Promise<void>;
    initializeExecution(binding: AgentHomeExecutionBinding): Promise<void>;
    /**
     * The task-free projection already applied to this home, from the SDK-owned
     * ordering record. Read it while the execution lease is held: `project()`
     * needs the same lease, so the record cannot change during the Attempt.
     */
    readAppliedProjection(binding: AgentHomeBinding): Promise<TerminalAgentHomeProjection | undefined>;
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
 * the lease that pins it, and the signed macOS or Windows helper binary. What it
 * cannot own is the memory authority itself — the compare-and-swap semantics,
 * the audit record, the platform gate, and the exact path policy the model is
 * allowed to name. Those must stay in one place or two implementations drift.
 *
 * This entry therefore exports exactly the pieces `daemon/task-runner.ts`
 * composes for an in-daemon Agent task, minus the daemon:
 *
 * - `AgentMemoryService`             — task-scoped recall/save authority.
 * - `captureAgentMemorySnapshot`     — the post-close bounded snapshot.
 * - `openAgentMemoryFilesystemHelper`— admission of the host's macOS or Windows helper.
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
 * uses the native descriptor backend, and macOS and Windows x64 require the
 * host's external helper. `isAgentMemorySecureFilesystemAvailable`
 * is the single gate a host consults before offering memory at all.
 */
/** Per-task memory authority: `recall`/`save` under sha256 compare-and-swap, bound to one exact active Agent task context. */
export { AgentMemoryService } from '../daemon/agent-memory';
/** Bounded, audited snapshot of the Agent's local memory files, taken after `Session.close()` while the home lease still exists. */
export { captureAgentMemorySnapshot } from '../daemon/agent-memory';
/** The sole platform gate for the memory write authority: native Linux, macOS and Windows x64 only with the host's helper. */
export { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
/** Compare-and-swap failure carrying the expected and actual content revisions. */
export { AgentMemoryRevisionConflictError } from '../daemon/agent-memory';
/** The exact active-task binding required to construct the service; every field is validated on each call. */
export type { AgentMemoryTaskContext } from '../daemon/agent-memory';
/** Result of `recall`, including the metadata-only audit warning when the audit write failed but the read did not. */
export type { AgentMemoryRecallResult } from '../daemon/agent-memory';
/** Result of `save`, distinguishing a replace (with new revision) from a delete. */
export type { AgentMemorySaveResult } from '../daemon/agent-memory';
/** Metadata-only signal that the audit record could not be written; the source operation still succeeded. */
export type { AgentMemoryAuditWarning } from '../daemon/agent-memory';
/** Whether this platform can admit an external filesystem helper at all (macOS and Windows x64 today). */
export { isAgentMemoryFilesystemHelperSupported } from '../daemon/agent-memory-fs-helper';
/** Admits the host's absolute signed/notarized helper binary and returns the root-pinned filesystem for one Agent home. */
export { openAgentMemoryFilesystemHelper } from '../daemon/agent-memory-fs-helper';
/** Root-bound filesystem authority the service operates through; the host supplies it only on macOS. */
export type { AgentMemoryFilesystem } from '../daemon/agent-memory-filesystem';
/** One file's state as reported by that filesystem authority. */
export type { AgentMemoryFilesystemFileState } from '../daemon/agent-memory-filesystem';
/** Serves `memory_recall`/`memory_save` as a stdio MCP server over host-provided streams. */
export { serveAgentMemoryMcpOverStdio } from './mcp-server';
/** MCP tool name a host must allowlist for reads. */
export { AGENT_MEMORY_RECALL_TOOL_NAME } from './mcp-server';
/** MCP tool name a host must allowlist for writes. */
export { AGENT_MEMORY_SAVE_TOOL_NAME } from './mcp-server';
/** The two calls the stdio server delegates to; an `AgentMemoryService` satisfies it directly. */
export type { AgentMemoryMcpDeps } from './mcp-server';
/** Runtime-neutral instructions telling the model how to use `MEMORY.md` and `notes/`. */
export { AGENT_MEMORY_GUIDANCE } from '../daemon/memory-guidance';
/** Prepends that guidance to an Agent instruction, exactly as the daemon's task runner does. */
export { prependAgentMemoryGuidance } from '../daemon/memory-guidance';
/** The validated Agent identity carried by `AgentMemoryTaskContext`. */
export type { AgentRef } from '../agent-home';
// ==== @byok-sdk/client dist/agent-memory/mcp-server.d.ts ====
import { type McpServerToolCall } from '../mcp-server';
export { AGENT_MEMORY_MCP_SERVER_INFO, AGENT_MEMORY_RECALL_TOOL_NAME, AGENT_MEMORY_SAVE_TOOL_NAME, AGENT_MEMORY_TOOLS, PREPARED_AGENT_MEMORY_OPERATION_META_KEY, type AgentMemoryOperation, type AgentMemoryToolDefinition, } from './tool-manifest';
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
/**
 * One `tools/call`, returning the JSON-RPC `result` payload. The path policy,
 * the compare-and-swap contract and the exact accepted argument set stay here;
 * envelope, framing and protocol faults belong to `../mcp-server`.
 */
export declare function handleAgentMemoryToolCall(call: McpServerToolCall, deps: AgentMemoryMcpDeps, mode: 'read' | 'read-write'): Promise<Record<string, unknown>>;
/** Lists the complete tool set; the prepared lane compares it with its sealed descriptor. */
export declare function serveAgentMemoryMcpOverStdio(input: {
    deps: AgentMemoryMcpDeps;
    mode: 'read' | 'read-write';
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
}): void;
/** Lists only the tools `mode` grants: a `read` helper lists `memory_recall` and no write tool. */
export declare function serveGrantedAgentMemoryMcpOverStdio(input: Parameters<typeof serveAgentMemoryMcpOverStdio>[0]): void;
/** A task-free descriptor has the same tools/list identity, but never an execution handler. */
export declare function serveAgentMemoryDescriptorOverStdio(input: {
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
}): void;
// ==== @byok-sdk/client dist/agent-memory/prepared-agent-memory.d.ts ====
import type { PreparedAgentMemoryMode } from '@byok-sdk/protocol';
import { type PreparedAgentMemoryObservation } from './prepared-capability';
/** The SDK-owned Agent-memory helper launch (`resolveSdkReservedHelperBin`). */
export interface PreparedAgentMemoryHelper {
    readonly command: string;
    readonly args: readonly string[];
}
/** The task-free descriptor observation a preparation is counted over. */
export interface PreparedAgentMemoryState {
    readonly observation: PreparedAgentMemoryObservation;
}
/** Spawn the task-free descriptor helper and read its tools/list answer. */
export declare function observePreparedMemory(describe: PreparedAgentMemoryHelper, env: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<PreparedAgentMemoryState>;
export declare function preparedMemoryProjection(mode: PreparedAgentMemoryMode, memory: PreparedAgentMemoryState | null, runtimeIdentity: string): {
    tools: readonly import("./prepared-capability").PreparedAgentMemorySelectedTool[];
    toolExecutors: {
        [k: string]: string;
    };
};
export declare function parsePreparedMemoryState(raw: unknown): PreparedAgentMemoryState | null;
// ==== @byok-sdk/client dist/agent-memory/prepared-capability.d.ts ====
import { type PreparedAgentMemoryMode } from '@byok-sdk/protocol';
import { PREPARED_AGENT_MEMORY_OPERATION_META_KEY, type AgentMemoryOperation } from './tool-manifest';
export { PREPARED_AGENT_MEMORY_OPERATION_META_KEY } from './tool-manifest';
export interface PreparedAgentMemoryObservationTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly _meta: Readonly<Record<typeof PREPARED_AGENT_MEMORY_OPERATION_META_KEY, AgentMemoryOperation>>;
}
/** SDK-specific tools/list observation. Generic Host MCP metadata is never accepted here. */
export interface PreparedAgentMemoryObservation {
    readonly serverInfo: {
        readonly name: string;
        readonly version: string;
    };
    readonly protocolVersion: string;
    readonly tools: readonly PreparedAgentMemoryObservationTool[];
}
/** Model-visible selection contains schemas only. Executor identities are intentionally computed separately. */
export interface PreparedAgentMemorySelectedTool {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
}
export declare function parsePreparedAgentMemoryMode(value: unknown): PreparedAgentMemoryMode;
export declare function preparedAgentMemoryModeAllowsOperation(mode: PreparedAgentMemoryMode, operation: AgentMemoryOperation): boolean;
export declare function preparedAgentMemoryModeWithinCeiling(requested: PreparedAgentMemoryMode, ceiling: PreparedAgentMemoryMode): boolean;
/** Strict parser for the task-free SDK descriptor. Missing/unknown operation metadata fails closed. */
export declare function validatePreparedAgentMemoryObservation(value: unknown): PreparedAgentMemoryObservation;
export declare function preparedAgentMemoryTools(mode: PreparedAgentMemoryMode, observation: PreparedAgentMemoryObservation): readonly PreparedAgentMemorySelectedTool[];
export declare function preparedAgentMemoryDescriptorDigest(observation: PreparedAgentMemoryObservation): string;
/** Per-tool executor fingerprints bind the complete descriptor, the selected mode and the runtime identity. */
export declare function preparedAgentMemoryExecutorFingerprints(observation: PreparedAgentMemoryObservation, mode: PreparedAgentMemoryMode, runtimeIdentity: string): readonly string[];
/** The sole canonical serialization used by descriptor validation and both memory digests. */
export declare function canonicalPreparedAgentMemoryJson(value: unknown): string;
// ==== @byok-sdk/client dist/agent-memory/tool-manifest.d.ts ====
import type { McpServerToolDefinition } from '../mcp-server';
export declare const AGENT_MEMORY_RECALL_TOOL_NAME = "memory_recall";
export declare const AGENT_MEMORY_SAVE_TOOL_NAME = "memory_save";
export declare const PREPARED_AGENT_MEMORY_OPERATION_META_KEY = "byok.agent-memory.operation";
export type AgentMemoryOperation = 'read' | 'write';
export interface AgentMemoryToolDefinition extends McpServerToolDefinition {
    readonly operation: AgentMemoryOperation;
    readonly _meta: Readonly<Record<typeof PREPARED_AGENT_MEMORY_OPERATION_META_KEY, AgentMemoryOperation>>;
}
/** The exact tools this server advertises. This table is the sole schema and operation-classification authority. */
export declare const AGENT_MEMORY_TOOLS: readonly AgentMemoryToolDefinition[];
export declare const AGENT_MEMORY_MCP_SERVER_INFO: Readonly<{
    name: "byok-agent-memory-mcp";
    version: "0.0.1";
}>;
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
 * `../daemon/control-client`, `../daemon/control-protocol` and `../daemon/store`
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
import { type AgentEvent } from '@byok-sdk/protocol';
import type { AgentRef } from '../agent-home';
import { type AgentEgressDropReason, type AgentEgressDropReceipt, type AgentEgressPolicy, type AgentEgressStatus } from './agent-egress-policy';
import { type AgentReliableAck, type AgentContentReceiptWithoutReliableIdentity, type AgentReliableEgressRecord } from './agent-egress-spool';
export interface AgentEgressControllerOptions {
    readonly policy: Readonly<AgentEgressPolicy>;
    /** Authenticated tenant identity, never accepted from an egress event. */
    readonly tenantId?: string;
}
export interface AgentEgressProgressInput {
    readonly agentRef: AgentRef;
    readonly taskId: string;
    readonly events: readonly AgentEvent[];
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
    /**
     * Coalesce to the latest value before TaskRunner builds a `task.progress`
     * envelope. Events go to the Host as the runtime produced them. An `error`
     * reports a failure, not a value a later event supersedes, so every accepted
     * `error` is sent; the other events of the batch coalesce to their last.
     */
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
/**
 * Policy used when the host configures no Agent egress. Activity goes to the
 * Host as the runtime produced it; the limits only bound transport.
 */
export declare const DEFAULT_AGENT_EGRESS_POLICY: Readonly<AgentEgressPolicy>;
export declare class AgentEgressPolicyError extends Error {
    readonly issues: readonly {
        path: readonly (string | number)[];
        message: string;
    }[];
    constructor(message: string, issues: readonly {
        path: readonly (string | number)[];
        message: string;
    }[]);
}
/** Resolve/validate once at construction; unknown policy shapes never become an implicit default. */
export declare function resolveAgentEgressPolicy(policy: AgentEgressPolicy | undefined): Readonly<AgentEgressPolicy>;
export declare function eventBytes(event: AgentEvent): number;
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
// ==== @byok-sdk/client dist/daemon/agent-memory-export.d.ts ====
import type { AgentHomeManager, AgentRef } from '../agent-home';
import { type AgentMemoryExport } from '@byok-sdk/protocol/agent-memory';
export interface AgentMemoryExportOptions {
    readonly signal?: AbortSignal;
}
/** Internal composition: only the daemon's explicit opt-in exposes this operation. */
export declare function exportAgentMemoryHome(homes: AgentHomeManager, agentRef: AgentRef, options?: AgentMemoryExportOptions, helper?: {
    readonly bin: string;
    readonly assetRoot?: string;
}): Promise<AgentMemoryExport>;
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
// ==== @byok-sdk/client dist/daemon/agent-memory-fs-helper.d.ts ====
import type { AgentHomeLease } from '../agent-home';
import type { AgentMemoryFilesystem } from './agent-memory-filesystem';
export declare const AGENT_MEMORY_FILESYSTEM_HELPER_PROTOCOL = 2;
export declare const AGENT_MEMORY_FILESYSTEM_HELPER_VERSION = "2";
export declare function isAgentMemoryFilesystemHelperSupported(): boolean;
/** Private protocol 2 identity. Decimal strings keep all 64 bits. */
export type AgentMemoryHelperIdentity = Readonly<{
    kind: 'unix';
    dev: string;
    ino: string;
}> | Readonly<{
    kind: 'windows';
    volumeSerial: string;
    fileIndex: string;
}>;
/** Serialization is not platform admission or a durability proof. */
export declare function agentMemoryHelperIdentity(home: AgentHomeLease['homeIdentity'], platform: NodeJS.Platform): AgentMemoryHelperIdentity;
export declare function agentMemoryHelperIdentityMatches(value: unknown, expected: AgentMemoryHelperIdentity): boolean;
export declare function openAgentMemoryFilesystemHelper(input: Readonly<{
    helperBin: string;
    assetRoot?: string | undefined;
    canonicalHome: string;
    homeIdentity: AgentHomeLease['homeIdentity'];
}>): Promise<AgentMemoryFilesystem>;
// ==== @byok-sdk/client dist/daemon/agent-memory-intent.d.ts ====
import { type AgentMemoryIntentAvailablePayload, type AgentMemoryIntentCompletion, type AgentMemoryIntentFileObservation, type AgentMemoryIntentOperation, type AgentMemoryIntentReadback, type AgentMemoryIntentRejectionCode } from '@byok-sdk/protocol';
import { type AgentHomeLease, type AgentHomeManager } from '../agent-home';
import type { AgentMemoryFilesystem } from './agent-memory-filesystem';
import { type AgentMemoryIntentTransport } from '@byok-sdk/protocol/agent-memory';
/**
 * Host-approved Agent memory intents — the daemon half.
 *
 * `agent.memory.intent.available` names one intent (`{ intentId, agentRef }`).
 * The daemon fetches the immutable intent from the Host through the injected
 * {@link AgentMemoryIntentTransport}, applies it with the existing sha256 CAS
 * AT MOST ONCE, and reports a content-free terminal completion. The device
 * ledger `.byok/agent-memory-intents-v1.json` is the at-most-once authority:
 *
 * - window 1 (home lease): look the intent up; a terminal is re-made durable
 *   (barrier) and re-completed; a leftover `applying` becomes `uncertain` and is
 *   never re-executed; no row reserves a slot (`held`) or cannot (`none`).
 * - fetch (no lease): the Host releases, withholds, terminates or defers.
 * - window 2 (home lease): durable `applying`, then ONE CAS, then a durable
 *   terminal. A release is consumed by exactly this window.
 * - complete (no lease): the completion goes to the Host; the readback must
 *   match it.
 * - window 3 (home lease): the `ackedAt` barrier. Only then does the notice
 *   resolve and the mailbox cursor move.
 *
 * Network I/O never runs while the home lease is held, and every intent of one
 * Agent is processed serially in this process.
 */
/** SDK-internal ledger file under the Agent home's `.byok` directory. */
export declare const AGENT_MEMORY_INTENT_LEDGER_FILENAME = "agent-memory-intents-v1.json";
/** Upper bound of one serialized ledger record plus its separating comma (R_MAX). */
export declare const AGENT_MEMORY_INTENT_LEDGER_RECORD_MAX_BYTES = 2048;
/** Bytes of the empty ledger `{"version":1,"records":[]}` (E). */
export declare const AGENT_MEMORY_INTENT_LEDGER_ENVELOPE_BYTES = 26;
/** Ledger capacity N = floor((1 MiB − E) / R_MAX) = 511. */
export declare const AGENT_MEMORY_INTENT_LEDGER_CAPACITY: number;
/** Closed reasons an intent notice is left un-acknowledged (the mailbox row and cursor stay). */
export declare const AGENT_MEMORY_INTENT_NOTICE_FAILURE_REASONS: readonly ['transport_unconfigured', 'filesystem_unavailable', 'home_busy', 'fetch_failed', 'fetch_invalid', 'complete_failed', 'readback_invalid', 'readback_mismatch', 'local_io_failed', 'ledger_full', 'ledger_invalid'];
export type AgentMemoryIntentNoticeFailureReason = (typeof AGENT_MEMORY_INTENT_NOTICE_FAILURE_REASONS)[number];
/**
 * The only error the intent processor throws. A fixed message built from a
 * closed reason and the intent id, no `cause`, no own enumerable properties:
 * nothing a Host transport threw or returned, and no memory path or content,
 * reaches the connection manager's log line.
 */
export declare class AgentMemoryIntentNoticeError extends Error {
    #private;
    constructor(reason: AgentMemoryIntentNoticeFailureReason, intentId: string);
    get reason(): AgentMemoryIntentNoticeFailureReason;
    get intentId(): string;
}
/**
 * What one memory filesystem backend has PROVEN. A backend whose proof is
 * missing fails closed: without `strictLedgerBarrier` the processor refuses to
 * run (and the capability is not advertised); without `conflictProvesNoRename`
 * a CAS revision conflict is reported as `uncertain`, never `conflict`.
 */
export interface AgentMemoryIntentBackend {
    /** Omitted for the native Linux descriptor backend. */
    readonly openFilesystem?: (lease: AgentHomeLease) => Promise<AgentMemoryFilesystem>;
    /** A thrown `AgentMemoryRevisionConflictError` proves this attempt renamed nothing. */
    readonly conflictProvesNoRename: boolean;
    /**
     * A successful write proves durable bytes, metadata and name changes.
     * Linux requires temp fsync, rename and directory fsync. Windows requires
     * model S proof for ledger, memory replace/delete and new parent directories
     * under process crash, OS crash and power loss. File flush alone is not B,
     * so the Windows helper backend reports `false`.
     */
    readonly strictLedgerBarrier: boolean;
}
/**
 * Native Linux descriptor backend: every CAS conflict is thrown before its
 * rename (`agent-memory.ts` replace/delete), and both the memory CAS and the
 * ledger writes use the strict directory-fsync variant.
 */
export declare const NATIVE_AGENT_MEMORY_INTENT_BACKEND: AgentMemoryIntentBackend;
/**
 * SDK release helper: verified Mach-O or PE code and pre-rename CAS. Only the
 * macOS helper has the strict barrier proof. Windows has no OS-crash or
 * power-loss proof, so it never advertises intents.
 */
export declare function helperAgentMemoryIntentBackend(helperBin: string, assetRoot?: string): AgentMemoryIntentBackend;
export interface AgentMemoryIntentProcessorOptions {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly transport: AgentMemoryIntentTransport | undefined;
    readonly homes: AgentHomeManager | undefined;
    /** `undefined` means no proven backend: every notice fails `filesystem_unavailable`. */
    readonly backend: AgentMemoryIntentBackend | undefined;
    /**
     * Called exactly once per acknowledged notice whose Host readback
     * contradicted the device terminal (`conflict`, or `host_terminal` against a
     * local terminal), after the integrity audit and the `ackedAt` barrier.
     * Metadata only.
     */
    readonly onIntegrity?: (event: Readonly<{
        intentId: string;
        disposition: 'conflict' | 'host_terminal';
    }>) => void;
}
/** What a processed notice resolved with (metadata only). */
export type AgentMemoryIntentProcessResult = Readonly<{
    kind: 'acknowledged';
    completion: AgentMemoryIntentCompletion;
    readback: AgentMemoryIntentReadback;
    /** The Host fact contradicted the device fact; an integrity audit was recorded. */
    integrity: boolean;
}> | Readonly<{
    kind: 'host_terminal';
    readback: AgentMemoryIntentReadback;
}>;
export type AgentMemoryIntentLedgerState = 'applying' | 'applied' | 'conflict' | 'rejected' | 'uncertain';
export interface AgentMemoryIntentLedgerRecord {
    readonly intentId: string;
    /** The notice `agentRef.profileRevision`; the agentId is the ledger's home. */
    readonly profileRevision: string;
    readonly path: string;
    readonly operation: AgentMemoryIntentOperation;
    readonly operationDigest: string;
    readonly baseRevision: string;
    readonly targetRevision: string | null;
    readonly approvalRef: string;
    readonly state: AgentMemoryIntentLedgerState;
    readonly detail: null | AgentMemoryIntentFileObservation | Readonly<{
        code: AgentMemoryIntentRejectionCode;
    }>;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly ackedAt: string | null;
}
/** Serialized byte length of one record (without its separating comma). */
export declare function agentMemoryIntentLedgerRecordBytes(record: AgentMemoryIntentLedgerRecord): number;
/**
 * The real ledger serializer: compact JSON `{"version":1,"records":[…]}`.
 * Throws when the record count exceeds N or a record plus its separator would
 * exceed R_MAX, which the field bounds make unreachable.
 */
export declare function serializeAgentMemoryIntentLedger(records: readonly AgentMemoryIntentLedgerRecord[]): string;
/**
 * `applied` is consistent with its operation, from the historical receipt
 * alone (never a re-read of the current file, never provenance from a hash):
 * replace → the target exists at `targetRevision`; delete → the target is
 * missing (empty-bytes revision) and the intent had a null `targetRevision`.
 */
export declare function agentMemoryIntentAppliedConsistent(operation: AgentMemoryIntentOperation, targetRevision: string | null, result: AgentMemoryIntentFileObservation): boolean;
/** Strictly parse a ledger body. Throws on anything it cannot vouch for; never resets. */
export declare function parseAgentMemoryIntentLedger(content: string): readonly AgentMemoryIntentLedgerRecord[];
/**
 * Build the `agent.memory.intent.available` processor. It resolves only after
 * the terminal completion was durable before `complete`, the Host readback
 * matched it, and the `ackedAt` barrier succeeded (or, for an intent with no
 * local row, after a validated Host terminal). Every other end throws one
 * {@link AgentMemoryIntentNoticeError}, which keeps the mailbox row.
 */
export declare function createAgentMemoryIntentProcessor(options: AgentMemoryIntentProcessorOptions): (payload: AgentMemoryIntentAvailablePayload) => Promise<AgentMemoryIntentProcessResult>;
// ==== @byok-sdk/client dist/daemon/agent-memory.d.ts ====
import { AGENT_MEMORY_PROJECTION_CAPABILITY, type AgentMemoryProjectionMutation } from '@byok-sdk/protocol';
import { type AgentHomeLease, type AgentRef } from '../agent-home';
import type { AgentMemoryFilesystem, AgentMemoryFilesystemFileState } from './agent-memory-filesystem';
import { AgentMemoryError, AgentMemoryValidationError, type AgentMemoryProjectionPort, type AgentMemorySnapshot } from '@byok-sdk/protocol/agent-memory';
export declare const AGENT_MEMORY_AUDIT_FILENAME = "agent-memory-audit-v1.jsonl";
/** v2 is one atomically replaced state file, never an append-only log. */
export declare const AGENT_MEMORY_OUTBOX_FILENAME = "agent-memory-redacted-outbox-v2.json";
export declare const AGENT_MEMORY_MAX_FILE_BYTES: number;
export declare const AGENT_MEMORY_MAX_SNAPSHOT_BYTES: number;
export declare const AGENT_MEMORY_MAX_SNAPSHOT_FILES = 128;
export declare const AGENT_MEMORY_MAX_SNAPSHOT_ENTRIES = 512;
/** One atomically replaced audit/outbox state must fit the cross-platform helper contract. */
export declare const AGENT_MEMORY_MAX_LOCAL_LOG_BYTES: number;
/** A complete snapshot cannot fit the bounded export contract. No partial result is returned. */
export declare class AgentMemorySnapshotLimitError extends AgentMemoryValidationError {
    constructor(message: string);
}
/**
 * Filesystem I/O failure: an open, read, write, fsync, rename or unlink did not
 * complete, or a file changed under a read. A retry may succeed, and a failure
 * after a rename says nothing about whether that rename became durable.
 */
export declare class AgentMemoryIoError extends AgentMemoryError {
    constructor(message: string);
}
export declare class AgentMemoryRevisionConflictError extends AgentMemoryError {
    readonly expectedRevision: string;
    readonly actualRevision: string;
    constructor(expectedRevision: string, actualRevision: string);
}
/**
 * The exact leased Agent home the memory primitives act on, and nothing else.
 * A task context is one (it carries these fields); a task-free Host intent
 * builds one from its own home lease with {@link agentMemoryHomeBinding}.
 */
export interface AgentMemoryHomeBinding {
    readonly canonicalHome: string;
    readonly homeIdentity: AgentHomeLease['homeIdentity'];
    /** Optional external root handle; omission selects the native Linux backend. */
    readonly filesystem?: AgentMemoryFilesystem;
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
/**
 * The sole platform gate for the Agent-memory write authority. Linux retains
 * the native procfs descriptor backend. macOS and Windows x64 require the SDK
 * release helper that passed its native proof and deployment digest check.
 * Other platforms remain unavailable rather than selecting an unproved fallback.
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
/** Validate and freeze a task-free home binding built from a live writer lease. */
export declare function agentMemoryHomeBinding(input: AgentMemoryHomeBinding): AgentMemoryHomeBinding;
/** One observation of a memory file: existence and the sha256 of its exact bytes. */
export interface AgentMemoryFileObservation {
    readonly exists: boolean;
    readonly revision: string;
}
/**
 * Observe one allowed memory path (`MEMORY.md` or `notes/**.md`) through the
 * pinned home, for evidence only (never for recall or save).
 *
 * The revision is the same definition every other memory read uses — sha256
 * over the file's exact bytes, the empty-bytes digest when missing — but the
 * bytes are streamed into the hash with no size bound and no UTF-8 decoding, so
 * an oversized or non-UTF-8 file is still observable. A missing leaf or a
 * missing parent directory is an observed absence.
 *
 * Still unobservable (thrown): a home whose pinned identity no longer matches
 * or that is gone; a symlink, non-directory or unopenable parent component; a
 * symlink or non-regular leaf, or a leaf with more than one hard link; a
 * name below notes that differs only in letter case from another; any other
 * open/read/stat I/O error; and a file that changed while it was hashed
 * (transient). With an external `filesystem` backend the observation is that
 * backend's bounded UTF-8 `read`.
 */
export declare function observeAgentMemoryHomeFile(binding: AgentMemoryHomeBinding, relativePath: string): Promise<AgentMemoryFileObservation>;
export interface AgentMemoryHomeCompareAndSwap {
    readonly operation: 'replace' | 'delete';
    readonly path: string;
    /** The sha256 revision the live file must have; a missing file is the empty-bytes digest. */
    readonly expectedRevision: string;
    /** Exactly for `replace`. */
    readonly content?: string;
}
/**
 * Exactly one sha256 compare-and-swap on one memory file, the same primitive
 * `memory_save` uses. Resolves with the file state after success (a delete
 * resolves with the missing-file state). Throws
 * {@link AgentMemoryRevisionConflictError} when the live revision differs,
 * {@link AgentMemoryValidationError} for a refused input, and
 * {@link AgentMemoryIoError} (or a backend error) otherwise.
 *
 * Native backend: every conflict is thrown before the rename that would
 * install new bytes (replace compares before the temp file, before its write
 * and after it; delete compares twice before its tombstone rename), so a
 * conflict means this call renamed nothing. Its directory fsync is strict, as
 * for the intent ledger: a success proves the rename reached the directory on
 * disk, and an `EINVAL`/`EPERM` refusal after it throws {@link AgentMemoryIoError}.
 */
export declare function compareAndSwapAgentMemoryHomeFile(binding: AgentMemoryHomeBinding, input: AgentMemoryHomeCompareAndSwap): Promise<AgentMemoryFilesystemFileState>;
/** Read one SDK-internal state file under `.byok` through the pinned home. */
export declare function readAgentMemoryHomeInternalFile(binding: AgentMemoryHomeBinding, fileName: string): Promise<AgentMemoryFilesystemFileState>;
/**
 * The durable-barrier write for SDK-internal state under `.byok`.
 *
 * A successful return covers the temp write, the temp file fsync, the rename
 * and the directory fsync. Unlike every other internal write, a directory
 * fsync error of ANY code — including the `EINVAL`/`EPERM` a filesystem uses to
 * refuse directory fsync — is a failure. A failure after the rename throws
 * too: the new bytes may be visible, but nothing proves they are durable.
 *
 * With an external `filesystem` the write is that backend's `replace`; its
 * durability is exactly that backend's guarantee.
 */
export declare function replaceAgentMemoryHomeInternalFileStrict(binding: AgentMemoryHomeBinding, fileName: string, expectedRevision: string, content: string): Promise<AgentMemoryFilesystemFileState>;
/**
 * Append one metadata-only line to the Agent memory audit tail. Audit is
 * observation, never replay authority; the entry must carry no memory content.
 */
export declare function appendAgentMemoryHomeAudit(binding: AgentMemoryHomeBinding, values: Readonly<Record<string, unknown>>): Promise<void>;
/**
 * Runtime evidence that the filesystem holding `directory` honors directory
 * fsync. `false` for any refusal (including `EINVAL`/`EPERM`), so a caller can
 * decline to promise a durable barrier the filesystem cannot give.
 */
export declare function probeAgentMemoryStrictDirectorySync(directory: string): Promise<boolean>;
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
/** Internal bounded capture; the caller must hold the exclusive home lease throughout. */
export declare function captureAgentMemoryHomeSnapshot(input: AgentMemoryHomeBinding, signal?: AbortSignal): Promise<AgentMemorySnapshot>;
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
    /**
     * Runtime cwd. For a writer session it is the canonical Agent home. For a
     * `memory-reader` session it is the run directory `<home>/.byok/runs/<taskId>`
     * that the first Attempt created; a resume runs there again.
     */
    readonly cwd: string;
    /** Present for a `memory-reader` session only; absent means a writer session. */
    readonly homeAccess?: 'memory-reader';
    readonly leaseId: string;
    readonly terminalCause?: AgentTerminalCause;
    readonly terminalReason?: string;
    readonly updatedAt: string;
}
/**
 * Exact session identity. Every field must match the recorded handoff,
 * including the access mode: a reader session never resumes as a writer, and
 * a writer session never resumes as a reader.
 */
export interface AgentSessionHandoffMatch {
    readonly agentRef: AgentRef;
    readonly sessionRef: string;
    readonly runtimeId: string;
    /**
     * Canonical Agent home. The session ledger lives in its
     * `.byok/runtime-sessions/`. Defaults to `cwd`, which is the home of a
     * writer session. A reader session must name it.
     */
    readonly home?: string;
    readonly cwd: string;
    readonly homeAccess?: 'memory-reader';
}
export interface AgentTaskTerminalEvidence {
    readonly agentRef: AgentRef;
    readonly taskId: string;
    readonly runtimeId: string;
    /** Sealed runtime cwd: the canonical Agent home, or a reader's run directory. */
    readonly cwd: string;
    /** Present for a `memory-reader` Attempt only. */
    readonly homeAccess?: 'memory-reader';
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
    /** Canonical Agent home, as in {@link AgentSessionHandoffMatch.home}. Defaults to `cwd`. */
    readonly home?: string;
    readonly cwd: string;
    readonly homeAccess?: 'memory-reader';
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
 * `.byok/runtime-sessions/`; session text never becomes a pathname. Corrupt
 * bytes are never interpreted as a missing mapping. Reader sessions keep their ledger in the home too, not in
 * their run directory, so a resume can find the run directory by sessionRef.
 */
export declare class AgentSessionHandoffStore {
    private readonly queues;
    get(expected: AgentSessionHandoffMatch): Promise<AgentSessionHandoff | undefined>;
    /** Append-only readback for audit/recovery; every terminal within the ledger's retention window remains visible. */
    history(expected: AgentSessionHandoffMatch): Promise<readonly AgentSessionHandoff[]>;
    /** Exact identity check used before a strict Agent resume is admitted. */
    requireMatch(expected: AgentSessionHandoffMatch): Promise<AgentSessionHandoff>;
    /**
     * The run directory a `memory-reader` session recorded, for its resume.
     * Throws a mismatch when no handoff exists, when the session was recorded
     * by a writer, or when the AgentRef or runtime differ.
     */
    readerSessionCwd(expected: Omit<AgentSessionHandoffMatch, 'home' | 'cwd' | 'homeAccess'> & {
        readonly home: string;
    }): Promise<string>;
    /**
     * Reader run directories that session ledgers of this home point to, each
     * with the last update time of its ledger in ms. Retention keeps these
     * directories until the record is older than the age limit. A corrupt
     * ledger throws, and the caller then skips retention.
     */
    readerRunReferences(home: string): Promise<ReadonlyMap<string, number>>;
    readerRunReferences(home: string, canContinue: () => boolean): Promise<ReadonlyMap<string, number> | undefined>;
    /** Append-only, fsynced write. The caller awaits this before task.started. */
    record(input: Omit<AgentSessionHandoff, 'updatedAt' | 'terminalCause' | 'terminalReason'> & {
        readonly home?: string;
    }): Promise<AgentSessionHandoff>;
    /** Records the first terminal cause without changing the exact handoff identity. */
    recordTerminal(expected: AgentSessionHandoffMatch, cause: AgentTerminalCause, reason?: string): Promise<AgentSessionHandoff>;
    /**
     * Persists a claimed Agent task failure that happened before an active
     * session handoff existed. Callers await the fsync before sending
     * `task.fail`, so cloud state can never outrun the Agent-local evidence.
     */
    recordTaskTerminal(input: Omit<AgentTaskTerminalEvidence, 'updatedAt' | 'terminalCause'> & {
        readonly home?: string;
    }): Promise<AgentTaskTerminalEvidence>;
    getTaskTerminal(expectedInput: AgentTaskTerminalMatch): Promise<AgentTaskTerminalEvidence | undefined>;
    private filePath;
    private taskTerminalFilePath;
    private enqueue;
    private load;
    /**
     * The latest session entry of one ledger file, or `undefined` for a
     * task-terminal evidence file. The two file kinds share one directory, and
     * a runtime id can make their names look alike, so the record kind decides.
     */
    private loadSessionLedger;
    private loadAll;
    private loadTaskTerminal;
    private append;
}
// ==== @byok-sdk/client dist/daemon/approvals.d.ts ====
/**
 * The pending-approval registry: the one place an approval is resolved.
 * `TaskRunner.requestApproval` registers each dispatched approval (from a
 * session's `approvalChannel` or the control socket's `approvals.request`);
 * wire and in-process decisions, the CLI's `approvals.resolve`, timeouts,
 * task finish and eviction all resolve it here, and here a control-socket
 * approval of a `tool-authorization` approval is refused (see
 * {@link ApprovalOrigin}).
 */
export type ApprovalDecision = 'approve' | 'reject';
/**
 * What an approval asks for. `task-terminal`: a runtime asks whether its task
 * may continue, and a rejection ends the task. `tool-authorization`: the
 * `auto` tool gate asks whether one high-risk tool call may run, and a
 * rejection denies that call while the turn continues.
 */
export type ApprovalKind = 'task-terminal' | 'tool-authorization';
/**
 * The channel a resolution arrived on. Two decisions depend on it:
 *
 * - Reporting. `'wire'` is a server-sent `task.approve`/`task.reject`
 *   (`TaskRunner.handleApprove`/`handleReject`): the server already knows it,
 *   so it is never echoed back. Every other origin is new to the server and is
 *   reported as `task.approval_resolved`.
 * - Authority. A `tool-authorization` approval is approved only by the Host:
 *   `'wire'` or `'in-process'` (`Daemon.approve`, called by a Host that embeds
 *   the daemon). `'control'` (the control socket's `approvals.resolve`, which
 *   `byok-agent approve` calls) can be used by any same-user process that can
 *   read `control.token`, including the agent being authorized, so it can only
 *   reject such an approval unless `DaemonConfig.localToolApproval` is
 *   `'allow'`.
 *
 * `'fail-closed'` is the device's own rejection: a `requestApproval` timeout
 * or withdrawal, task finish, registry eviction, or an approval that could not
 * be sealed for the Host.
 */
export type ApprovalOrigin = 'wire' | 'in-process' | 'control' | 'fail-closed';
/** Whether the control socket may approve a `tool-authorization` approval. Absent means it may only reject. */
export type LocalToolApprovalPolicy = 'allow';
/** What `approvals.list` returns per pending approval — deliberately small; a runtime-specific payload (e.g. the exact tool call awaiting approval) is Phase 3's concern, not this registry's. */
export interface PendingApproval {
    approvalId: string;
    taskId: string;
    kind: ApprovalKind;
    summary?: string;
    createdAt: string;
}
/** Stable control error code for a control-socket approval of a `tool-authorization` approval. */
export declare const APPROVAL_REQUIRES_HOST = "approval_requires_host";
export declare class ApprovalNotFoundError extends Error {
    constructor(approvalId: string);
}
/**
 * The control socket tried to approve a `tool-authorization` approval while
 * `DaemonConfig.localToolApproval` is not `'allow'`. The approval stays
 * pending: the Host can still decide it, and the control socket can still
 * reject it.
 */
export declare class ApprovalRequiresHostError extends Error {
    readonly code = "approval_requires_host";
    constructor(approvalId: string);
}
/** Cap on simultaneously pending approvals — generous for any plausible concurrent-approval workload, and existing purely as a defensive bound (mirrors `task-runner/state.ts`'s `MAX_TRACKED_TASK_IDS`/`observer.ts`'s `MAX_TRACKED_TASKS`), not a real-world limit this is expected to ever approach. */
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
    private readonly localToolApproval;
    constructor(options?: {
        localToolApproval?: LocalToolApprovalPolicy;
    });
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
     * Throws {@link ApprovalRequiresHostError}, leaving the approval pending,
     * when a `'control'` origin approves a `tool-authorization` approval and
     * `localToolApproval` is not `'allow'`. Every origin may reject.
     */
    resolve(approvalId: string, decision: ApprovalDecision, reason: string | undefined, origin: ApprovalOrigin): void;
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
 * the index exports nothing else. See also `daemon/control-client.ts`'s own doc
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
import type { DeviceCredentialBackend } from './device-credential-store';
/**
 * Thrown when the server has revoked this device (protocol §6.3): a
 * `/byok/challenge` or `/byok/token` 401 with the typed
 * `device_not_registered` body, or an untyped 401 that one rechecked exchange
 * met again. The only recourse is a fresh `/byok/pair` — callers must surface
 * a clear "re-pair needed" state and must NOT retry the renewal in a loop.
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
/**
 * Thrown when a successful `/byok/challenge` or `/byok/token` response body
 * is not valid JSON or does not satisfy its protocol schema
 * (`ChallengeResponseSchema` / `TokenResponseSchema`, #386) — for example a
 * truncated body, a missing field, or a token `expiresAt` that is not an ISO
 * timestamp with an offset — and when a token or pair response carries no
 * `expiresIn` (#1114). The renewal or pairing fails and the prior credential
 * is kept unchanged; nothing is inferred from the malformed body. The JSON
 * `SyntaxError` or the schema failure rides in `cause`. Not a revocation.
 */
export declare class AuthResponseInvalidError extends Error {
    readonly route: 'challenge' | 'token' | 'pair';
    constructor(route: 'challenge' | 'token' | 'pair', options: {
        cause: unknown;
    });
}
/**
 * One measurement of this device's clock against the server's HTTP `Date`
 * header (#1114). It is reported only (`byok-agent doctor`); token lifetime never
 * reads it.
 */
export interface ClockSkewObservation {
    /** Positive when the device clock is ahead of the server's. */
    readonly deviceAheadMs: number;
    /** Half the request round trip plus the header's one-second resolution. */
    readonly uncertaintyMs: number;
    /** ISO time the response arrived on the device clock. */
    readonly observedAt: string;
}
export interface AuthManagerOptions {
    serverUrl: string;
    store: DeviceStore;
    /** Internal-only credential custody seam. Product construction uses store.credentials. */
    credentials?: DeviceCredentialBackend;
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
    /**
     * The sole cancellation authority for the serialized credential mutation
     * now running: its HTTP requests, back-off and OS credential commands all
     * take this signal.
     */
    private activeMutation;
    private lastRenewedAt;
    private nearExpiryRenewals;
    private lastClockSkew;
    private readonly credentials;
    private readonly requestDeadlineMs;
    constructor(opts: AuthManagerOptions);
    get deviceId(): string | undefined;
    isRevoked(): boolean;
    /** The skew measured by the last successful pair or renewal, if its response carried a parseable `Date` and the device clock did not go back mid-request. */
    clockSkew(): ClockSkewObservation | undefined;
    /**
     * Internal signer read: always recompose metadata with the current OS
     * secret authority. Like every OS read here it is a credential mutation, so
     * {@link stop} cancels it.
     */
    readCurrent(): Promise<DeviceRecord | undefined>;
    /**
     * Re-arm after {@link stop}. The daemon calls it inside a start or pair's
     * lifecycle slot, after checking that no later stop cancelled the request.
     */
    resume(): void;
    /**
     * Load the paired device record for a daemon run. Every call rereads the
     * OS authority and revalidates this storeDir's binding (#1094), including
     * on an instance that already holds a record: another store may have
     * replaced the enrollment since. The read runs as a credential mutation,
     * so {@link stop} cancels a read hung on a locked keychain.
     */
    loadExisting(): Promise<DeviceRecord | undefined>;
    /**
     * `POST /byok/pair` (v2): generates a device keypair on first pair, reuses
     * it on any subsequent (e.g. post-revocation) re-pair of this store. It
     * refuses with {@link DeviceStoreBindingMismatchError} while the OS entry
     * holds an enrollment this storeDir did not pair, unless
     * `replaceOtherStore` states the operator's intent to replace it; the
     * replacement never reuses that enrollment's key.
     */
    pair(pairingCode: string, options?: {
        readonly replaceOtherStore?: boolean;
    }): Promise<DeviceRecord>;
    /** The current, non-expired access token — renews first if it's expired or close to it. Throws {@link DeviceRevokedError} if the device has been revoked. */
    getValidAccessToken(): Promise<string>;
    /** Force a renewal regardless of the cached token's remaining lifetime — the reactive path, used after a caller sees a 401. */
    handleUnauthorized(): Promise<string>;
    stop(): Promise<void>;
    private renew;
    private doRenew;
    /**
     * One challenge → token exchange. Resolves `undefined` when either step
     * answered an untyped 401; a typed revocation 401 halts inside.
     */
    private exchangeToken;
    /** A typed revocation 401 halts now; any other 401 resolves `undefined` for the one recheck. */
    private readUnauthorized;
    private backOff;
    /** Always throws — `never` return type lets call sites use `if (x === 401) this.markRevoked();` without an explicit `return`/`throw` of their own. */
    private markRevoked;
    private scheduleProactiveRenewal;
    private msUntilRenewAllowed;
    /**
     * Bounds one complete auth exchange rather than fetch alone. Keeping the
     * controller active through `json()`/`text()` makes a non-cooperative or
     * partial response body cancellable by the same authority that owns fetch.
     */
    private runRequest;
    private runCredentialMutation;
    /**
     * Read the current paired authority afresh; metadata without its OS secret
     * is re-pair required, and an OS enrollment this storeDir's `device.json`
     * does not name is never adopted.
     */
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
    /** The blob's bytes, after the declared SHA-256 and size check. */
    downloadBlob(blobRef: BlobRef, options?: BlobRequestOptions): Promise<Uint8Array>;
    /** `POST /byok/blobs` -> PUT the bytes to the presigned URL -> finalize into a `BlobRef`. */
    uploadArtifact(content: string | Uint8Array, contentType: string, options?: BlobRequestOptions & {
        readonly idempotencyKey?: string;
    }): Promise<BlobRef>;
}
// ==== @byok-sdk/client dist/daemon/config-schema/check.d.ts ====
import type { LocalAgentReleaseIdentity } from '../../release-identity';
import type { RuntimeAdapter } from '../../types';
import { type DaemonEffectiveConfig } from './effective';
import { type DaemonConfigIssue, type DaemonConfigSource } from './validate';
export interface DaemonConfigCheckOptions {
    readonly source: DaemonConfigSource;
    /**
     * `cli`: the distribution's release identity, added after validation,
     * because a config file must not carry `localAgentRelease`.
     */
    readonly localAgentRelease?: LocalAgentReleaseIdentity;
    /** The adapters a Host passes to `createDaemonWithAdapters`. Absent: the set `createDaemon` builds. */
    readonly adapters?: readonly RuntimeAdapter[];
}
export interface DaemonConfigCheck {
    /** No `error` issue. A caller that treats warnings as failures (`config check --strict`) checks `issues`. */
    readonly ok: boolean;
    readonly issues: readonly DaemonConfigIssue[];
    /** The effective values, when the config would construct a daemon. */
    readonly effective?: DaemonEffectiveConfig;
}
/**
 * Validates a `DaemonConfig` without constructing a daemon and, when it
 * would construct, reports its effective values (#1094). Literal problems
 * come from {@link validateDaemonConfig}; a value daemon construction would
 * refuse (a range, a cross-field rule, a scratch root past the socket budget,
 * a static tool-authorization mode the adapters cannot run) is an
 * `invalid_value` error. Reads the filesystem (helper assets, store
 * path canonicalization) but writes nothing and starts no process.
 */
export declare function checkDaemonConfig(input: unknown, options: DaemonConfigCheckOptions): DaemonConfigCheck;
// ==== @byok-sdk/client dist/daemon/config-schema/effective.d.ts ====
import { type ToolAuthorizationMode, type ToolFileScope } from '../../tool-authorization';
import type { RuntimeAdapter, RuntimeVersionPolicy } from '../../types';
import type { DaemonConfig, DaemonStatus } from '../create-daemon';
import type { DaemonConfigIssue } from './validate';
/**
 * How daemon construction resolved the SDK Agent memory filesystem helper
 * (#603, #614).
 *
 * - `not-needed`: no Agent home, or memory is off and no memory feature is configured.
 * - `native`: Linux; the descriptor backend needs no helper.
 * - `resolved`: macOS or Windows x64; the SDK release helper at `path` passed its digest check.
 * - `missing`: macOS or Windows x64, but the helper did not resolve; memory is
 *   silently unavailable (#603). `reason` says why.
 * - `unsupported-platform`: no secure memory backend on this platform.
 */
export type DaemonMemoryHelperResolution = {
    readonly state: 'not-needed' | 'native' | 'unsupported-platform';
} | {
    readonly state: 'resolved';
    readonly path: string;
} | {
    readonly state: 'missing';
    readonly reason: string;
};
/** One MCP server a task of this daemon may get. */
export interface DaemonEffectiveMcpServer {
    readonly name: string;
    /** `sdk-reserved`: an SDK helper. `host-toolset`: a server of `DaemonConfig.mcpToolsets`. */
    readonly kind: 'sdk-reserved' | 'host-toolset';
    /** `per-task`: mounted for each task that `when` describes. `off` / `unavailable`: never mounted. */
    readonly mount: 'per-task' | 'off' | 'unavailable';
    /** Which tasks get it (`per-task`), or why it is never mounted. */
    readonly detail: string;
}
/** One runtime adapter of this daemon. */
export interface DaemonEffectiveRuntime {
    readonly id: string;
    /** `sdk-built`: `createDaemon` built it from config. `injected`: passed to `createDaemonWithAdapters`. */
    readonly source: 'sdk-built' | 'injected';
    /** Whether an `auto` tool-authorization offer can run on it. */
    readonly toolAuthorizationAuto: boolean;
    /**
     * The isolation options `createDaemon` gives an SDK-built adapter. Absent
     * for an injected adapter, whose options the Host set when it built it.
     */
    readonly isolation?: Readonly<Record<string, string>>;
    /**
     * The effective version policy (#1103), resolved once at adapter
     * construction; only the policy, never the installed runtime token.
     */
    readonly versionPolicy?: RuntimeVersionPolicy;
}
/**
 * Effective values of one daemon's configuration (#1094): what it resolved
 * from `DaemonConfig`, beyond the literal fields. `byok-agent config check`
 * and `Daemon.status().config` both return this, from the same function.
 */
export interface DaemonEffectiveConfig {
    /** Version of the generated `daemon-config.schema.json` this daemon validates against. */
    readonly schemaVersion: number;
    /** Unknown-field warnings; a daemon starts with them (Q4'). */
    readonly warnings: readonly DaemonConfigIssue[];
    readonly directories: {
        readonly storeDir: {
            readonly path: string;
            readonly source: 'config' | 'default';
        };
        /** `agentHome.hostStorageRoot`, resolved. Absent without an Agent home. */
        readonly hostStorageRoot?: string;
        /** `<hostStorageRoot>/agents`, the SDK-owned parent of every Agent home. */
        readonly agentHomes?: string;
        /** `<storeDir>/service-logs`, where `byok-agent service install` sends the daemon's stdout and stderr. */
        readonly logDir: string;
        /**
         * Execution scratch root (#493). `config`: `storage.scratchRoot`. `store`:
         * `<storeDir>/tmp`. `short-root`: the store path is too long for runtime
         * Unix sockets, so scratch moved to a fixed short root.
         */
        readonly scratchRoot: {
            readonly path: string;
            readonly source: 'config' | 'store' | 'short-root';
            /** Byte length of `path`, and the longest root runtime sockets allow on this platform (absent: unbounded). */
            readonly socketPathBytes: number;
            readonly socketPathMaximumBytes?: number;
        };
    };
    readonly memory: {
        /** Same value as `DaemonStatus.agentMemoryMcp`. */
        readonly mcp: DaemonStatus['agentMemoryMcp'];
        readonly helper: DaemonMemoryHelperResolution;
    };
    readonly mcpServers: readonly DaemonEffectiveMcpServer[];
    readonly runtimes: readonly DaemonEffectiveRuntime[];
    readonly toolAuthorization: DaemonEffectiveToolAuthorization;
}
/**
 * How this daemon decides each task's tool-authorization mode.
 *
 * - `all`: no `DaemonConfig.toolAuthorization`; every task runs `all`.
 * - `static`: a policy; `byRuntime` holds the mode of every runtime of this
 *   daemon (its `byRuntime` entry, else `default`).
 */
export type DaemonEffectiveToolAuthorization = ({
    readonly mode: 'all';
} | {
    readonly mode: 'static';
    readonly byRuntime: Readonly<Record<string, ToolAuthorizationMode>>;
}) & {
    /** Who may approve a `tool-authorization` approval: `host-only` (default) or `allow` (the control socket too). */
    readonly localToolApproval: 'host-only' | 'allow';
    /**
     * The configured explicit file scope (#1061), copied and normalized.
     * Absent means `inherit`: no file-scope policy is configured and behavior
     * is unchanged. `home` is the canonical Agent home read+write; `workspaces`
     * adds the listed roots (`write` implies `read`). Whether the selected
     * runtime/lane/platform can enforce it is per-offer admission.
     */
    readonly fileScope?: ToolFileScope;
};
export interface EffectiveDaemonConfigInput {
    readonly config: DaemonConfig;
    readonly warnings: readonly DaemonConfigIssue[];
    readonly memoryHelper: DaemonMemoryHelperResolution;
    readonly agentMemoryMcpAdmission: DaemonStatus['agentMemoryMcp'];
    /** Resolved `storeDir`. */
    readonly storeDir: string;
    /** Resolved scratch root. */
    readonly scratchRoot: string;
    readonly adapters: readonly RuntimeAdapter[];
    readonly runtimeSource: 'sdk-built' | 'injected';
    readonly platform?: NodeJS.Platform;
}
export declare function describeEffectiveDaemonConfig(input: EffectiveDaemonConfigInput): DaemonEffectiveConfig;
// ==== @byok-sdk/client dist/daemon/config-schema/errors.d.ts ====
import { DaemonConfigFieldRemovedError } from '../daemon-errors';
import { type DaemonConfigIssue } from './validate';
/**
 * `DaemonConfig` failed {@link validateDaemonConfig} at daemon construction:
 * a missing required field, or a value of the wrong JSON type or literal.
 * A removed field throws {@link DaemonConfigFieldRemovedError} instead.
 */
export declare class DaemonConfigInvalidError extends Error {
    readonly issues: readonly DaemonConfigIssue[];
    readonly code: 'daemon_config_invalid';
    constructor(issues: readonly DaemonConfigIssue[]);
}
/** The typed error for a removed field `path` (config or overrides). */
export declare function removedFieldError(path: string): DaemonConfigFieldRemovedError;
/**
 * Construction-time validation (#1094): throws on the first removed field,
 * then on any other error, and returns the unknown-field warnings (Q4':
 * never rejected). Daemon construction logs them once and reports them in
 * `Daemon.status().config`; `checkDaemonConfig` only reports them.
 */
export declare function assertDaemonConfigValid(config: unknown): readonly DaemonConfigIssue[];
// ==== @byok-sdk/client dist/daemon/config-schema/index.d.ts ====
/** #1094: the DaemonConfig schema, its one validator and the effective-values report. */
export { DAEMON_CONFIG_SCHEMA_VERSION } from './schema.generated';
export { validateDaemonConfig } from './validate';
export type { DaemonConfigIssue, DaemonConfigIssueCode, DaemonConfigSource, DaemonConfigValidation } from './validate';
export { checkDaemonConfig } from './check';
export type { DaemonConfigCheck, DaemonConfigCheckOptions } from './check';
export { DaemonConfigInvalidError } from './errors';
export type { DaemonEffectiveConfig, DaemonEffectiveMcpServer, DaemonEffectiveRuntime, DaemonEffectiveToolAuthorization, DaemonMemoryHelperResolution } from './effective';
// ==== @byok-sdk/client dist/daemon/config-schema/removed-fields.d.ts ====
/**
 * `DaemonConfig` fields that no longer exist (#1094). The one table both the
 * validator and the generated schema (`x-byok-removedFields`) read: supplying
 * one of these is a typed {@link DaemonConfigFieldRemovedError} on every
 * surface, never an unknown-field warning, because the Host relied on it and
 * must change its config or code.
 *
 * Every entry points at the migration note in `docs/spec.md`.
 *
 * This module has no imports so the schema generator can load it with Node's
 * type stripping.
 */
export interface RemovedDaemonConfigField {
    /** Dotted path from the config root, e.g. `workspaceRoot` or `agentEgress.sanitizer`. */
    readonly path: string;
    /** What replaced it; the error message. */
    readonly message: string;
    /** Repo-relative `.md#anchor` of the migration note. */
    readonly migration: string;
}
export declare const REMOVED_DAEMON_CONFIG_FIELDS_MIGRATION = "docs/spec.md#removed-daemonconfig-fields";
export declare const REMOVED_DAEMON_CONFIG_FIELDS: readonly RemovedDaemonConfigField[];
// ==== @byok-sdk/client dist/daemon/config-schema/schema-types.d.ts ====
/**
 * The JSON Schema subset `generate-schema.mjs` emits for `DaemonConfig`, and
 * the only subset the validator interprets (#1094).
 */
export type DaemonConfigSurface = 'embedded-only' | 'distribution-owned';
export interface DaemonConfigJsonSchema {
    readonly type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
    readonly const?: string | number | boolean;
    readonly enum?: readonly (string | number | boolean)[];
    readonly anyOf?: readonly DaemonConfigJsonSchema[];
    readonly properties?: Readonly<Record<string, DaemonConfigJsonSchema>>;
    readonly required?: readonly string[];
    readonly additionalProperties?: DaemonConfigJsonSchema;
    readonly items?: DaemonConfigJsonSchema;
    readonly prefixItems?: readonly DaemonConfigJsonSchema[];
    readonly minItems?: number;
    readonly maxItems?: number;
    /** Always `{}` here: set only on a surface-restricted property, so any value fails a JSON Schema validator. */
    readonly not?: Readonly<Record<string, never>>;
    readonly 'x-byok-surface'?: DaemonConfigSurface;
    /**
     * `function`: an embedded Host may pass a function instead of this object
     * schema; a config file must set the object.
     */
    readonly 'x-byok-embeddedAlternative'?: 'function';
    readonly 'x-byok-schemaVersion'?: number;
    readonly 'x-byok-removedFields'?: readonly {
        readonly path: string;
        readonly migration: string;
    }[];
}
// ==== @byok-sdk/client dist/daemon/config-schema/schema.generated.d.ts ====
import type { DaemonConfigJsonSchema } from './schema-types';
export declare const DAEMON_CONFIG_SCHEMA_VERSION = 1;
export declare const DAEMON_CONFIG_SCHEMA: DaemonConfigJsonSchema;
// ==== @byok-sdk/client dist/daemon/config-schema/validate.d.ts ====
import { type RemovedDaemonConfigField } from './removed-fields';
/**
 * Where a `DaemonConfig` comes from (#1094).
 *
 * - `cli`: a `byok-agent` JSON config file. Embedded-only fields (functions,
 *   transports) and the distribution-owned `localAgentRelease` are errors.
 * - `embedded`: an object a Host passes to `createDaemon` or
 *   `createDaemonWithAdapters`. Embedded-only fields are allowed and checked
 *   by daemon construction.
 */
export type DaemonConfigSource = 'cli' | 'embedded';
export type DaemonConfigIssueCode = 'not_an_object' | 'missing_required' | 'invalid_type' | 'invalid_value' | 'invalid_version_policy' | 'invalid_file_scope' | 'unknown_field' | 'removed_field' | 'embedded_only' | 'distribution_owned';
/**
 * One finding of {@link validateDaemonConfig}. Messages name the field path
 * and the expected type, never the supplied value.
 */
export interface DaemonConfigIssue {
    /** `warning` never stops a daemon (Q4'); `byok-agent config check --strict` fails on it. */
    readonly severity: 'error' | 'warning';
    readonly code: DaemonConfigIssueCode;
    /** Dotted path from the config root; `''` for the root itself. */
    readonly path: string;
    readonly message: string;
    /** Repo-relative `.md#anchor` of the migration note, for `removed_field`. */
    readonly migration?: string;
}
export interface DaemonConfigValidation {
    /** No `error` issue. Warnings do not affect it. */
    readonly ok: boolean;
    readonly issues: readonly DaemonConfigIssue[];
}
/** The removed-field entry for `path`, if `path` names a removed `DaemonConfig` field. */
export declare function removedDaemonConfigField(path: string): RemovedDaemonConfigField | undefined;
/**
 * The one `DaemonConfig` validator, shared by `byok-agent` (config files) and
 * daemon construction (#1094). It checks what the generated schema
 * (`daemon-config.schema.json`) expresses: required fields, JSON types and
 * literal values, unknown fields and removed fields. Value ranges and
 * cross-field rules stay with daemon construction, which reports them as
 * construction errors.
 *
 * An unknown field is a `warning`: a config written by a newer Host or SDK
 * must still start an older daemon after a rollback (Q4'). A removed field is
 * an `error` with its migration note, because the Host relied on it.
 */
export declare function validateDaemonConfig(input: unknown, options: {
    readonly source: DaemonConfigSource;
}): DaemonConfigValidation;
// ==== @byok-sdk/client dist/daemon/connection-manager.d.ts ====
import type { HarnessInfo } from '@byok-sdk/protocol';
import { type OutboundRefusalReason, type ActivityIngress, type CapabilityFlag, type Envelope, type RuntimeInfo, type RuntimeUnavailableEntry, type ToolsetId } from '@byok-sdk/protocol';
import { AuthManager } from './auth-manager';
import type { CursorStore } from './cursor-store';
import type { DaemonHaltReason } from './daemon-lifecycle';
import { type FleetJitter } from './deterministic-jitter';
export { ReplayCursorTooOldError } from './replay-cursor';
/**
 * #1121: the most bytes of droppable envelopes the outbox holds while the
 * Host is unreachable. Past it the oldest of them are dropped unsent.
 */
export declare const MAX_OUTBOX_EPHEMERAL_BYTES: number;
/**
 * The daemon's one long-poll session: `open` from the moment the server
 * accepts this session's `conn.hello` until any route fails, `connecting`
 * otherwise.
 */
export type ConnectionState = 'connecting' | 'open';
/** The remote conditions that end a session for good. */
export type ConnectionHaltReason = Extract<DaemonHaltReason, 'device_revoked' | 'handshake_rejected' | 'replay_cursor_too_old'>;
export interface ConnectionManagerOptions {
    serverUrl: string;
    deviceId: string;
    productId: string;
    capabilities: CapabilityFlag[];
    /** U4a Local Agent release version, sent unchanged in `conn.hello`. */
    clientVersion?: string;
    runtimes: RuntimeInfo[];
    harnesses?: HarnessInfo[];
    /** Strip-safe non-available projection from the same start snapshot (#1103 B2b). */
    runtimeUnavailable?: readonly RuntimeUnavailableEntry[];
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
    /** Every transition between `connecting` and `open`, starting with `connecting` from {@link ConnectionManager.start}. */
    onStateChange?: (state: ConnectionState) => void;
    /**
     * Called each time the server's advertisement newly carries a capability
     * the previous one did not — after every reconnect, the first advertisement
     * is new in full. Hooks that retry capability-gated sends wait here.
     */
    onCapabilitiesAdvertised?: (added: readonly string[]) => void;
    /** Await durable disposition before retiring the exact accepted/rejected bytes. */
    onOutboundSettled?: (settlements: readonly OutboundSettlement[]) => Promise<void>;
    onOutboundQueued?: (envelope: Envelope) => void;
    /** An ephemeral envelope left the outbox unsent because the outbox passed {@link MAX_OUTBOX_EPHEMERAL_BYTES}. */
    onOutboundDropped?: (envelope: Envelope) => void;
    beforeOutboundPost?: (envelopes: readonly Envelope[]) => void;
    /**
     * Base of the capped exponential backoff (`backoffCeilingMs`) before each
     * reconnect handshake, and for stalled-cycle and local-disposition retries.
     * A route's `Retry-After` lengthens the reconnect wait. Default 2s.
     */
    longPollRetryDelayMs?: number;
    /** Minimum delay before the next long-poll request after an empty (no-events) response. Default 250ms. */
    longPollIdleDelayMs?: number;
    fleetJitter?: FleetJitter;
    onOperationalOutcome?: (outcome: 'success' | 'failure', source: 'reconnect' | 'upload') => void;
    /** The session ended for good; nothing reconnects after this. Called once. */
    onHalted?: (reason: ConnectionHaltReason) => void;
    /**
     * An observer callback ({@link onStateChange}, {@link onCapabilitiesAdvertised})
     * or the reconnect loop itself threw. The session ends for good, as for a
     * halt: nothing reconnects. Called once, never for a halt or a stop.
     */
    onCrashed?: (error: unknown) => void;
}
/** One outbound envelope's settlement; only a rejection has a reason, and it always has one. */
export type OutboundSettlement = {
    readonly envelope: Envelope;
    readonly outcome: 'accepted' | 'duplicate';
} | {
    readonly envelope: Envelope;
    readonly outcome: 'rejected';
    readonly reason: OutboundRefusalReason;
};
/**
 * Owns the daemon's one authenticated long-poll session with the server.
 * Every received envelope passes through the same cursor-dedupe/persistence
 * logic (protocol §9), so redelivery remains safe after a reconnect or a
 * daemon restart.
 *
 * One reconnect loop (`run`) owns the session. Each pass POSTs a lone
 * `conn.hello`; the server accepting it is what `open` means — it proves the
 * credentials, the device's enrollment, and the product and protocol match in
 * one round trip, without waiting for work or a held poll. Only an open
 * session polls and drains the outbox, so `conn.hello` is the first message
 * of every session, including after a reconnect (protocol §8). Any route
 * failure returns the session to `connecting` and the loop handshakes again
 * after the capped exponential `fleetJitter('reconnect')`, or the server's
 * `Retry-After` when that is longer. A rejected hello, a revoked device or a
 * lost replay cursor halts it instead.
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
    private reconnectAttempt;
    private started;
    private state;
    /** Aborts the reconnect loop's in-flight handshake and backoff on stop or halt. */
    private readonly lifetime;
    /** Ends the current open session; set only while one is open. */
    private endSession;
    /** Counts open sessions, so a request from an ended session cannot end the next one. */
    private sessionGeneration;
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
    /**
     * The latest server-advertised activity ingress. Every accepted handshake
     * answer and every events page carries one, so it is set before any session
     * opens; there is no client-side default.
     */
    private ingressBudget;
    /**
     * Finding F5(b): the envelopes `drainOutbox` has
     * currently spliced OUT of `this.outbox` for an in-flight (not yet
     * confirmed delivered) `postBatch` call — empty the rest of the time. See
     * `outboxLength`'s own doc comment for why this needs to be tracked
     * separately from `this.outbox` at all.
     */
    private inFlightBatch;
    /**
     * Every id in `outbox` or `inFlightBatch`, mapped to its encoded size when
     * the envelope is droppable and 0 otherwise. `send()` dedups against it in
     * O(1), and `ephemeralBytes` is the sum of its values.
     */
    private readonly queuedIds;
    private ephemeralBytes;
    private draining;
    private stopped;
    private haltReason;
    private crashed;
    private pendingCursorSave;
    /** Admission dedup while an individual handler is running. */
    private readonly inFlightSeqs;
    /** Successful side effects retained until their durable acknowledgement. */
    private readonly processedSeqs;
    private readonly failedEnvelopes;
    /** Received work lacking a successful handler receipt, including malformed frames. */
    private readonly unresolvedSeqs;
    /**
     * Finding P3: the pending local-disposition retry backoff in `drainOutbox`,
     * if any — cancellable so a halt or stop can unblock it immediately. See
     * `drainRetryDelay`.
     */
    private cancelPendingDrainRetry;
    /** The longest `Retry-After` a route answered since the last reconnect wait; see `nextReconnectDelayMs`. */
    private retryAfterMs;
    /**
     * The capabilities the current server response advertised — untyped
     * `string[]` for forward compatibility. An advertisement is scoped to the
     * current session and is cleared when it ends (a route failure, stop, or
     * halt). This keeps capability-gated outbound messages fail-closed until
     * the current server has explicitly advertised support.
     */
    private serverCapabilities;
    constructor(opts: ConnectionManagerOptions);
    /**
     * Loads the durable cursor and starts the reconnect loop. Resolves without
     * waiting for the server: {@link ConnectionManagerOptions.onStateChange}
     * reports `open`, and {@link ConnectionManagerOptions.onHalted} a halt.
     */
    start(): Promise<void>;
    /**
     * The one reconnect loop. Each pass handshakes with a lone `conn.hello`,
     * then serves an open session until it ends, then backs off with
     * `fleetJitter('reconnect')` before the next handshake.
     */
    private run;
    /**
     * The wait before the next handshake: the capped exponential
     * `fleetJitter('reconnect')` for this attempt, or the server's last
     * `Retry-After` when that is longer. A `Retry-After` is consumed by the one
     * wait it lengthens.
     */
    private nextReconnectDelayMs;
    /** One open session: from an accepted handshake until a route failure, stop, or halt ends it. */
    private serveSession;
    /**
     * A route failed: back to `connecting` synchronously, so nothing queued in
     * the meantime is sent ahead of the next session's handshake.
     */
    private breakSession;
    private applyServerCapabilities;
    private setState;
    /**
     * Observer callbacks run inside the reconnect loop, the poll loop and the
     * drain. A throw there is a crash of this connection, never a route
     * failure to retry or an unhandled rejection.
     */
    private notify;
    private isEnded;
    /**
     * Design B (finding N4): push onto the single shared outbox and try to
     * drain it now. Never routes directly to either transport itself — see
     * `drainOutbox`.
     * An id still queued or in flight is not queued again, so a timer retry
     * during an outage keeps one copy in its original place (#693).
     * An ended session (halted, crashed or stopped) queues nothing, so its
     * outbox cannot grow; a terminal is journaled before it is sent (#1119).
     */
    send(envelope: Envelope): void;
    /** The envelope left the outbox for good: settled, filtered out, or dropped. */
    private forget;
    /**
     * #1121: an outage must not grow the outbox without bound. Over the cap, the
     * oldest queued `task.progress` and `agent.message.draft` envelopes are
     * dropped until it fits again. Nothing else is ever dropped: terminals are
     * journaled and resent from the journal, and claim, started and approval
     * envelopes carry task state. The Host tolerates a gap in progress seqs.
     * An envelope already in flight is not dropped.
     */
    private dropOldestEphemeral;
    /** Publish a fresh local configuration snapshot while this daemon is running. */
    refreshHello(): void;
    /**
     * POSTs the outbox through long-poll in chunks of at most
     * `MAX_MESSAGES_PER_BATCH` envelopes and `MESSAGES_SEND_MAX_BODY_BYTES` of
     * encoded body (one envelope always goes; the cloud answers 413 above the
     * byte cap, and sealed envelopes reach about 350 KB each). Finding P1:
     * the server hard-caps a single
     * `/byok/messages` batch there (`MessagesSendRequestSchema`, protocol
     * §8.2) and 400s the WHOLE request if it's exceeded, which — before this
     * fix — meant more than that queued during an outage produced an oversize
     * batch that the server would reject forever, since the client re-queued
     * and retried the identical (still oversize) batch unchanged. Each chunk
     * is one `LongPollClient.postBatch` call; on success the loop continues
     * (more may still be queued, or the next chunk still needs sending), on
     * failure that SAME chunk is unshifted back (order-preserving, same
     * Envelope objects/ids — never rebuilt, so a retry is exactly the resend
     * Wave 1's server-side dedup expects). A route failure ends the session —
     * the reconnect loop handshakes again and the next open session resumes
     * the drain; a local durable-disposition failure is retried within the
     * session after a short backoff.
     * Runs only while the session is open, so it never sends ahead of the
     * session's `conn.hello`. Re-entrancy is guarded by `draining`: a call
     * arriving while a drain is already in progress just returns — the
     * in-progress loop's own `while (this.outbox.length > 0)` check picks up
     * anything newly pushed.
     */
    private drainOutbox;
    /**
     * Finding P3: backoff delay for `drainOutbox`'s local-disposition retry.
     * Unlike a plain `setTimeout`-based wait, this is (a) cancellable —
     * `halt()` and `stop()` call `cancelPendingDrainRetry()` to unblock an
     * in-flight wait immediately instead of leaving `drainOutbox` parked here
     * for up to the rest of the delay before it next checks the session —
     * and (b) unref'd, so the timer never keeps the Node process alive by
     * itself while nothing else (such as the live long-poll GET) legitimately is.
     */
    private drainRetryDelay;
    /**
     * The capabilities the current session's server advertised — on the
     * handshake answer or a poll response. Empty before either and after the
     * session ends.
     */
    getServerCapabilities(): readonly string[];
    /** True while the server has accepted this session's `conn.hello` and no route has failed since. */
    isOpen(): boolean;
    /** Why the session ended for good, if it did. */
    getHaltReason(): ConnectionHaltReason | undefined;
    /** The device was found revoked outside this session's own requests (proactive token renewal). */
    noteDeviceRevoked(): void;
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
     * Deliberately `this.outbox.length + this.inFlightBatch.length`, NOT just
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
    /** Throws before the first advertisement: no work runs before an accepted handshake. */
    getIngressBudget(): Readonly<ActivityIngress>;
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
     * - F2 (redelivery dead on reconnect): cursor accounting covers only
     *   work envelopes. `conn.*` envelopes never advance the cursor, so a
     *   handshake frame can never make a backlog envelope's lower seq look
     *   already delivered.
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
    /**
     * Ends the session for good: stops the loop, the poll and the drain, then
     * reports the reason once. The outbox keeps whatever it held and takes
     * nothing more, so `outboxLength()` stays an honest count of what never left.
     */
    private halt;
    /** The defined end for an unexpected error: stop like a halt, then report it once. */
    private crash;
}
// ==== @byok-sdk/client dist/daemon/control-protocol.d.ts ====
import type { TaskState } from '@byok-sdk/protocol';
import type { ApprovalDecision, PendingApproval } from './approvals';
import type { ClockSkewObservation } from './auth-manager';
import type { StoragePressureState } from './retention/pressure';
import type { RetentionSnapshot } from './retention/sweeper';
import type { OperationalHealthSnapshot } from './operational-health';
import type { DaemonLifecycle } from './daemon-lifecycle';
import type { RuntimeObservation, RuntimeVersionChange } from '../runtime-detection';
import type { ServiceEnvironmentStatus, ServiceEnvironmentUnavailableCode } from '../login-shell-environment';
import type { RuntimeEnvironmentReport } from '../runtime/environment';
import type { LocalAgentReleaseIdentity } from '../release-identity';
import type { McpToolsetConfig, McpToolsetRegistryStatus, RuntimeExecutableSource, RuntimeVersionVerdict } from '../types';
import type { AgentHomeExecutionStatus } from '../agent-home';
import type { InputPreparationCancelParamsV1, InputPreparationLookupParamsV1, InputPreparationReceiptV1, InputPreparationRequestV1 } from '../input-preparation';
/**
 * M4 Phase 2: shared local-IPC contract between the daemon's control server
 * (`control-server.ts`) and the CLI's control client (`daemon/control-client.ts`)
 * — frame shapes, endpoint path/pipe-name derivation, and the HMAC handshake
 * math. Both sides import from here so the two can never independently drift
 * (e.g. a mismatched HMAC label string, or a socket path computed two
 * slightly different ways).
 *
 * Transport: NDJSON (one JSON object per line) over a Unix domain socket
 * (darwin/linux) or a Windows named pipe — both addressed by the same
 * path-like string via Node's `net` module, so neither `control-server.ts`
 * nor `daemon/control-client.ts` needs to special-case the transport itself,
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
 * `storeDir` must come from `DeviceStore.resolveDir`, so the daemon and every
 * client derive the name from the same folded spelling.
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
/** Thrown by a method handler to control the wire error `{code, message}` a caller sees — anything else thrown surfaces as a generic `internal_error`. See `control-server.ts`'s dispatch and `daemon/control-client.ts`'s `request()` (which re-throws this same class on the client side). */
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
 * `daemon/control-client.ts`) destroys the connection on that throw.
 */
export declare const MAX_LINE_BYTES: number;
/**
 * Buffers raw socket bytes and yields complete lines. Splits on the raw byte
 * `0x0a` BEFORE any UTF-8 decoding — `0x0A` can only ever appear as an actual newline in
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
 * Always present. Registry measurements and their timestamp are explicit;
 * unconfigured scopes remain unmeasured, and budget is optional.
 */
export interface ControlStorageStatus extends RetentionSnapshot {
    readonly budget?: {
        readonly budgetBytes: number;
        readonly pressureState: StoragePressureState;
    };
}
/** The `runtimes.environment` method (#1095): every adapter's runtime environment names, built on demand. */
export declare const RUNTIMES_ENVIRONMENT_METHOD = "runtimes.environment";
/**
 * One adapter's entry in {@link ControlRuntimesEnvironmentResult}: the report
 * of a build (names and sources, never values), the login-shell capture's
 * failure code, or `failed` when the adapter's build threw anything else.
 */
export type ControlRuntimeEnvironment = ({
    readonly runtimeId: string;
    readonly status: 'built';
} & RuntimeEnvironmentReport) | {
    readonly runtimeId: string;
    readonly status: 'unavailable';
    readonly code: ServiceEnvironmentUnavailableCode;
} | {
    readonly runtimeId: string;
    readonly status: 'failed';
};
/** Result shape for the `runtimes.environment` method, in the daemon's adapter order. */
export interface ControlRuntimesEnvironmentResult {
    readonly runtimes: readonly ControlRuntimeEnvironment[];
}
/** Result shape for the `status` method — see `create-daemon.ts`'s control-method wiring for how each field is sourced, and `diagnostics/format.ts`'s `formatLiveStatusLines` for how the CLI renders it. */
export interface ControlStatusResult {
    /** Process-immutable Local Agent application release; absent only for an older control peer. */
    localAgentRelease?: Readonly<LocalAgentReleaseIdentity>;
    pid: number;
    uptimeMs: number;
    paired: boolean;
    deviceId?: string;
    /** Issues #391/#394: the same value as `Daemon.status().lifecycle`. */
    lifecycle: DaemonLifecycle;
    activeTasks: ControlActiveTask[];
    /**
     * Absent for a pre-#392 control peer: report unknown, never probe locally.
     * A pre-#1103 client validates every key of each entry, so the policy verdict
     * travels in {@link runtimeVersionVerdicts} instead of inside this array;
     * that keeps an older CLI's strict observation parser working against a newer
     * daemon. New readers merge the two.
     */
    runtimes?: RuntimeObservation[];
    /** #1103: verdicts for the same runtime ids as {@link runtimes}; absent from a pre-#1103 daemon. */
    runtimeVersionVerdicts?: Array<{
        readonly id: string;
        readonly versionVerdict: RuntimeVersionVerdict;
    }>;
    /** #1103 §2.6: this run's restart comparison, same side-channel rule; absent from a pre-#1103 daemon. */
    runtimeVersionChanges?: Array<{
        readonly id: string;
        readonly versionChange: RuntimeVersionChange;
    }>;
    /** #1103 O10: the executable each runtime's detection ran, same side-channel rule; absent from an older daemon. */
    runtimeExecutables?: Array<{
        readonly id: string;
        readonly executablePath?: string;
        readonly executableSource: RuntimeExecutableSource;
    }>;
    /** Absent for a pre-#392 control peer. */
    environment?: ServiceEnvironmentStatus;
    /** Timestamp of the same environment-resolved event; absent before startup resolves it. */
    environmentResolvedAt?: string;
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
    storage: ControlStorageStatus;
    /** Local retry budget. This is not the lifecycle above. */
    operationalHealth: OperationalHealthSnapshot;
    outbound: import('./outbound-settlement').OutboundStatus;
    /** Redacted content-addressed status from the daemon's single local registry. */
    toolsets: McpToolsetRegistryStatus;
    /**
     * WP0: per-canonical-Agent-home execution serialization, counts only —
     * see {@link AgentHomeExecutionStatus}. Absent only for an older control
     * peer that predates the cap.
     */
    agentHomeExecution?: AgentHomeExecutionStatus;
    /**
     * #1114: the device clock against the server's HTTP `Date` header at the
     * last successful pair or renewal. Absent when the daemon has no
     * observation (no pair or renewal since start, or the response carried no
     * parseable `Date`) and from an older control peer: report unknown.
     */
    clockSkew?: ClockSkewObservation;
}
export interface ToolsetsReloadParams {
    expectedRevision: string;
    mcpToolsets: Record<string, McpToolsetConfig>;
}
/** Maximum opaque pairing-code payload accepted over local control IPC. */
export declare const ENROLLMENT_PAIRING_CODE_MAX_BYTES = 1024;
export interface EnrollmentPairParams {
    pairingCode: string;
    /** The base32 E2EE pairing verification secret (#654 §7.2). The daemon decodes it; it never reaches the Host. */
    verificationSecret?: string;
}
/**
 * Exact shape gate for service-identity pairing. The code is opaque server
 * authority: this only bounds transport bytes and rejects unknown fields; it
 * never parses, normalizes or logs the code or the verification secret.
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
 * Shared control method for an adapter's out-of-process approval channel.
 * taskId correlates the request to an active task; summary is carried into
 * task.await_approval. Claude no longer consumes this method.
 */
export interface ApprovalsRequestParams {
    taskId: string;
    summary: string;
}
export declare function parseApprovalsRequestParams(value: unknown): ApprovalsRequestParams | undefined;
/** Result of the retained shared approvals.request control method. */
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
/**
 * `agent_results.describe`: the SDK result helper asks, by its per-task
 * context token, for the one tool it advertises. The schema is the offer's
 * frozen result schema and travels only over this authenticated socket,
 * never through the helper's environment or argv.
 */
export interface AgentResultDescribeParams {
    contextToken: string;
}
export declare function parseAgentResultDescribeParams(value: unknown): AgentResultDescribeParams | undefined;
export interface AgentResultDescribeResult {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
/**
 * `agent_results.submit`: the helper forwards the model's raw `submit_result`
 * arguments as `outcome`. The daemon is the only validator.
 */
export interface AgentResultSubmitParams {
    contextToken: string;
    outcome: unknown;
}
export declare function parseAgentResultSubmitParams(value: unknown): AgentResultSubmitParams | undefined;
/** One bounded validation issue, as the protocol's `validateResultOutcome` reports it. */
export interface AgentResultIssue {
    pointer: string;
    keyword: string;
    message: string;
}
/**
 * `staged` means only that the canonical outcome is durably recorded for this
 * task; delivery is decided at `turn_end`. `rejected` stores nothing and the
 * runtime may submit again.
 */
export type AgentResultSubmitResult = {
    state: 'staged';
    receiptId: string;
} | {
    state: 'rejected';
    reason: string;
    issues: AgentResultIssue[];
    truncated: boolean;
};
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
import type { OutboundStatus } from './outbound-settlement';
import { type RuntimeObservation } from '../runtime-detection';
import { type ServiceEnvironmentStatus } from '../login-shell-environment';
import type { AgentEgressPolicy, RuntimeId } from '@byok-sdk/protocol';
import type { RuntimeAdapter, RuntimeVersionPolicy, McpToolsetConfig, McpToolsetObservation, McpToolsetRegistryStatus, McpToolsetReloadReceipt } from '../types';
import { type AgentHomeExecutionStatus, type AgentHomeProjection } from '../agent-home';
import type { AgentRef } from '../agent-home';
import { type LocalAgentReleaseIdentity } from '../release-identity';
import { type CodexAdapterOptions, type CodexSandboxSetting } from '../adapters/codex/codex-adapter';
import type { ClaudeAdapterOptions } from '../adapters/claude/claude-adapter';
import type { PiAdapterOptions } from '../adapters/pi/pi-adapter';
import { type RuntimeEnvironmentPolicy } from '../runtime/environment';
import { type LocalToolApprovalPolicy } from './approvals';
import { type DaemonLifecycle } from './daemon-lifecycle';
import { type ControlStorageStatus } from './control-protocol';
import { type InputPreparationAuthorityResolver, type InputPreparationCounterAdapter, type InputPreparationLimitsPolicyV1 } from '../input-preparation';
import { type OperationalHealthSnapshot } from './operational-health';
import { type DaemonEventListener, type DaemonTaskInfo, type Unsubscribe } from './observer';
import { type DeviceEnrollment } from './store';
import { type LocalTaskJournal } from './journal/journal';
import type { JournalOpenFaultSeam } from '../util/sqlite-support';
import { type StorageConfig } from './retention/config';
import { type RetentionTimers } from './retention/sweeper';
import { type ProgressBatcherOptions } from './progress-batcher';
import { type AgentEgressReliableAppendResult } from './agent-egress-controller';
import { type AgentEgressStatus } from './agent-egress-policy';
import { type ProviderProvisioningHandler } from './provider-provisioning';
import { type AgentMemoryExportOptions } from './agent-memory-export';
import { type SdkHelperHostConfig } from '../sdk-reserved-helper-host';
import { type AgentMemoryHostedProjection } from './agent-memory';
import { type AgentContentReadRoot } from './agent-content-read';
import type { ToolAuthorizationPolicy } from '../tool-authorization';
import { type DaemonEffectiveConfig } from './config-schema/effective';
import type { AgentMemoryExport, AgentMemoryIntentTransport } from '@byok-sdk/protocol/agent-memory';
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
export interface DaemonConfig {
    /** Absolute native asset root for SDK-created runtime adapters. Custom adapters own their option. */
    nativeAssetRoot?: string;
    /**
     * Per-task tool authorization, decided by this Host for every runtime:
     * `all` (default) never blocks and emits a `tool-reminder` event for each
     * high-risk call; `auto` asks the user through the task's approval path
     * before a high-risk call runs and is declined before claim on a runtime
     * without `toolAuthorizationAuto`. `byRuntime` overrides the mode for one
     * runtime id. `rules` move single calls across the ask boundary and apply
     * to every runtime. A config file and an embedded Host supply the same
     * object; it is validated, copied and frozen before claim, once per offer
     * (including resume). Invalid policies decline the offer. Rules never
     * change the wire or native launch.
     *
     * The optional `fileScope` (#1061) is an explicit file boundary for the
     * SDK-owned file tools: absent means inherit (unchanged behavior);
     * `home` authorizes read+write of the canonical Agent home; `workspaces`
     * adds explicit read/write roots. It applies only to `auto` tasks, requires
     * `agentHome`, and is never selected by the wire or the model. v1 admits it
     * only on the ordinary Pi RPC lane on darwin/linux; other adapters, the
     * prepared/durable lanes, memory-reader offers and Windows decline before
     * claim with `file_scope_unsupported`. On the admitted path every configured
     * root is revalidated after claim and before the runtime starts; a missing,
     * symlinked, replaced or otherwise unresolvable root fails the claimed task
     * with a typed `file_scope_unavailable` reason instead of starting
     * unscoped. This is not an OS sandbox and slice 2 does not replace Pi's
     * native file tools: shell, MCP servers and extensions remain outside it,
     * and scoped file tools/tool-call enforcement ship in a later slice.
     */
    toolAuthorization?: ToolAuthorizationPolicy;
    /**
     * Who may approve a `tool-authorization` approval (an `auto` high-risk tool
     * call). Absent (default): only the Host — a wire `task.approve` or an
     * in-process {@link Daemon.approve}. The control socket's
     * `approvals.resolve` (`byok-agent approve`) can only reject it, and an
     * approve fails with the control error code `approval_requires_host`
     * ({@link APPROVAL_REQUIRES_HOST}). `'allow'` lets the control socket
     * approve it too. Any same-user process that can read `control.token`,
     * including the agent whose tool call waits, can then approve it, and the
     * server records it as a local approval. `task-terminal` approvals are not
     * affected. See `docs/security.md`.
     */
    localToolApproval?: LocalToolApprovalPolicy;
    /** Select an explicit macOS keychain for device enrollment custody. */
    deviceCredentials?: import('./device-credential-store').DeviceCredentialConfig;
    storage?: StorageConfig;
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
    /** Task memory MCP admission. Absent/auto preserves platform-based admission; off disables both ordinary and prepared memory tools,
     * and drops the Agent memory guidance from Agent task instructions. `status().agentMemoryMcp` reports the effective admission.
     * This does not disable explicit hosted projection/intent transports, and is not a filesystem sandbox. */
    agentMemoryMcp?: 'auto' | 'off';
    /** Optional, one-way hosted projection. Without all guards it has zero network activity. */
    agentMemory?: AgentMemoryHostedProjection;
    /** Explicit raw local Host export opt-in. No control/wire endpoint, upload, or projection callback. Requires agentHome and the admitted Linux, macOS or Windows x64 memory backend. */
    agentMemoryExport?: true;
    /** Absolute directory copied by copyAgentMemoryHelperAssets. Only SDK release assets are admitted; not a helper executable or digest override. */
    agentMemoryHelperAssetRoot?: string;
    /**
     * Explicit composition for SDK-reserved MCP helpers when this daemon is
     * embedded in a single-file/SEA product executable. The product entrypoint
     * must also call `runSdkReservedHelperCommand()` before its own CLI parser.
     */
    sdkHelperHost?: SdkHelperHostConfig;
    /**
     * How many `homeAccess: 'memory-reader'` Attempts this daemon lets run
     * CONCURRENTLY in one canonical Agent home, across every lane and every
     * session. Default {@link DEFAULT_MAX_CONCURRENT_READER_ATTEMPTS_PER_AGENT_HOME} (4).
     *
     * Readers are counted apart from the writer. A home has at most one writer
     * Attempt, fixed: the writer runs in the home itself, so a second writer
     * would co-write `MEMORY.md`, `notes/` and `.git`. Each reader runs in its
     * own run directory, `<home>/.byok/runs/<taskId>/`. An offer over either
     * limit is declined retryably before adapter preparation, the claim, or any
     * process side effect.
     *
     * Validated up front, the same way `maxTaskOutputBytes` is: a positive safe
     * integer, so `0`, a negative number, `NaN` and a non-integer are
     * construction errors rather than a silently reinterpreted "unlimited".
     *
     * The removed `maxConcurrentMutableSessionsPerAgentHome` is a construction
     * error: a value above 1 let Attempts co-write one home, which reader
     * Attempts replace.
     */
    maxConcurrentReaderAttemptsPerAgentHome?: number;
    /**
     * How many tasks this daemon runs at once, across every Agent home, lane and
     * runtime. Default {@link DEFAULT_MAX_CONCURRENT_TASKS} (8).
     *
     * Active tasks and offers already admitted but still starting both count.
     * An offer over the cap is declined retryably (`task.decline` with
     * `retryable: true` and no code) before adapter preparation, the claim, or
     * any process side effect, so the Host can offer it again later or to
     * another device.
     *
     * Validated up front: a positive safe integer. There is no "uncapped"
     * value; `0`, a negative number, `NaN` and a non-integer are construction
     * errors.
     */
    maxConcurrentTasks?: number;
    /**
     * Wall-clock limit, in milliseconds, for a task whose offer carries no
     * `limits.maxDurationMs`. An offer's own limit always wins. Enforced the
     * same way: the task fails with `resource limit exceeded: maxDurationMs`.
     * Omitted, a task without an offer limit runs until it ends or is
     * cancelled. Validated up front: a positive safe integer.
     */
    defaultMaxDurationMs?: number;
    /**
     * Explicit Agent-local/cloud egress selection. Omission still enforces the
     * SDK metadata/status projection, but does not advertise or admit the new
     * policy/reliable protocol surface.
     */
    agentEgress?: AgentEgressConfig;
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
     * Isolation options of the runtime adapters `createDaemon` builds (#1094),
     * passed to each adapter's constructor; an unset option keeps the
     * adapter's default, under which a runtime keeps the user's own context,
     * sessions and MCP servers. Which runtimes are built stays
     * `runtimeAllowlist`, and the Codex sandbox stays `codexSandbox`.
     * `createDaemonWithAdapters` rejects this key, even when undefined:
     * configure each injected adapter directly.
     */
    runtimes?: {
        pi?: {
            /** `PiAdapterOptions.agentUserContext`: `excluded` keeps user Pi resources and settings out of an Agent task (model and auth stores stay). Default `inherit`. */
            agentUserContext?: PiAdapterOptions['agentUserContext'];
            /** A complete version policy that replaces the adapter default wholesale; `block` is allowed here because it is Host configuration (#1103). */
            versionPolicy?: RuntimeVersionPolicy;
        };
        claude?: {
            /** `ClaudeAdapterOptions.agentUserContext`: `excluded` keeps user MCP servers, `CLAUDE.md` files, rules and auto memory out of an Agent task. Default `inherit`. */
            agentUserContext?: ClaudeAdapterOptions['agentUserContext'];
            /** `ClaudeAdapterOptions.agentSessionPersistence`: `disabled` does not save an Agent task's session transcript, so it cannot be resumed. Default `enabled`. */
            agentSessionPersistence?: ClaudeAdapterOptions['agentSessionPersistence'];
            /** A complete version policy that replaces the adapter default wholesale; `block` is allowed here because it is Host configuration (#1103). */
            versionPolicy?: RuntimeVersionPolicy;
        };
        codex?: {
            /** `CodexAdapterOptions.agentUserMcpServers`: `excluded` disables the user's MCP servers and plugins for an Agent task. Default `inherit`. */
            agentUserMcpServers?: CodexAdapterOptions['agentUserMcpServers'];
            /** A complete version policy that replaces the adapter default wholesale; `block` is allowed here because it is Host configuration (#1103). */
            versionPolicy?: RuntimeVersionPolicy;
        };
    };
    /**
     * The environment every runtime `createDaemon` builds gives its children
     * (#1095): by default the user's login-shell snapshot, so a variable the
     * Host sets in `process.env` reaches a runtime only when `pass` names it.
     * `createDaemonWithAdapters` refuses this field: each injected adapter
     * takes its own `runtimeEnvironment` option.
     */
    runtimeEnvironment?: RuntimeEnvironmentPolicy;
    /**
     * Separate-process Pi BYOK credential boundary. Required only for a
     * `dispatchSelection` in the BYOK lane; subscription runtimes and legacy
     * Pi tasks do not invoke it.
     */
    /** Disabled by default. Requires Agent homes, journal and custody launcher. */
    durablePi?: boolean;
    piByokLauncher?: import('../adapters/pi/pi-adapter').PiByokLauncherConfig;
    /**
     * M5 batch-3 (workstream 1): explicit auto-select priority order for
     * `TaskRunner.pickAdapter`'s no-explicit-runtime branch (`task-runner.ts`)
     * — tried in listed order; the first candidate that is both PRESENT
     * (`adapter.detect()`) and CAPABLE (declares MCP toolset projection when
     * the offer requires it) wins. Unset defaults to
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
     * Codex sandbox for the bundled Codex adapter that `createDaemon` builds,
     * as OAR's `OAR_CODEX_SANDBOX`. Default `danger-full-access`. `inherit`
     * passes no sandbox override, so the user's own `config.toml` applies.
     * `createDaemon` throws a TypeError for any other value.
     * `createDaemonWithAdapters` rejects this key, even when undefined.
     * Configure the injected CodexAdapter with its own sandbox option.
     */
    codexSandbox?: CodexSandboxSetting;
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
     * `MAX_OUTPUT_BYTES_EXCEEDED_REASON_PREFIX`, `task-runner/state.ts`) — see
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
     * the server-advertised activity ingress budget.
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
     * Timing and event-count batching policy. The server owns the byte ceiling.
     */
    progressBatch?: ProgressBatcherOptions;
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
     * Host consumer for the task-free `provider.provisioning.available` notice
     * (sealed provider provisioning). See {@link ProviderProvisioningHandler}.
     *
     * OFF by default, and the `provider-provisioning.v1` capability is advertised
     * only while a handler is present, so a Host never enqueues a notice this
     * daemon cannot consume. A notice that arrives anyway (a stale row, or a
     * sender that ignored the capability) is NOT acknowledged: the daemon throws,
     * the mailbox row is retained and the cursor stays behind it.
     *
     * The handler receives only `{ requestId }` and resolves with the Host's
     * durable terminal readback; the cursor advances only after that readback
     * validates against this tenant, device and request.
     */
    providerProvisioning?: ProviderProvisioningHandler;
    /**
     * Host transport for the task-free `agent.memory.intent.available` notice
     * (Host-approved Agent memory intents). See {@link AgentMemoryIntentTransport}.
     *
     * OFF by default. The `agent-memory-intent.v1` capability is advertised only
     * while this transport is present AND `agentHome` is configured AND the
     * secure memory filesystem is available AND that backend's ledger write is
     * a proven durable barrier (temp sync, rename, directory sync). Linux uses
     * native descriptors. macOS uses the verified SDK helper after a strict
     * full-sync volume probe. Windows does not advertise: its helper has no
     * OS-crash or power-loss proof. A notice that arrives without the capability is NOT
     * acknowledged: it fails `transport_unconfigured` or
     * `filesystem_unavailable` before any fetch. There is no control-socket
     * method for intents; the only entry is the mailbox notice.
     */
    agentMemoryIntents?: AgentMemoryIntentTransport;
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
    /**
     * Exact policy the daemon is willing to consume from an Agent offer.
     * Absent: the client default policy, as a config file's `"agentEgress": {}`.
     */
    policy?: AgentEgressPolicy;
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
    /** Environment selected by this daemon's host process at startup. */
    environment: ServiceEnvironmentStatus;
    environmentResolvedAt?: string;
    /** Startup observations for every configured adapter; status never re-probes. */
    runtimes: RuntimeObservation[];
    storage: ControlStorageStatus;
    /** Process-immutable Local Agent application release captured at construction. */
    localAgentRelease: Readonly<LocalAgentReleaseIdentity>;
    paired: boolean;
    /**
     * Issues #391/#394: where this daemon is in its lifecycle, including whether
     * the server has accepted it (`running` + `connection: 'open'`) and why a
     * run ended for good (`halted`). The same value every `lifecycle` event
     * carries.
     */
    lifecycle: DaemonLifecycle;
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
    outbound: OutboundStatus;
    /** WP0: per-canonical-Agent-home execution serialization — see {@link AgentHomeExecutionStatus}. */
    agentHomeExecution: AgentHomeExecutionStatus;
    /**
     * Effective daemon-level SDK memory MCP admission for ordinary Agent tasks.
     * `admitted`: Agent tasks get the SDK memory MCP; a writer gets
     * `memory_recall` and `memory_save`, a `memory-reader` Attempt only
     * `memory_recall`. The selected adapter must still support MCP toolsets for
     * each task. `off`: `DaemonConfig.agentMemoryMcp` is `off`; no Agent task
     * gets the memory MCP or the memory guidance. `unavailable`: `auto`, but
     * this daemon has no Agent home or no secure memory filesystem (for example
     * macOS or Windows x64 without the SDK release helper, or Windows arm64).
     */
    agentMemoryMcp: 'admitted' | 'off' | 'unavailable';
    /**
     * Effective values of this daemon's configuration (#1094): resolved
     * directories (store, Agent homes, execution scratch root and its socket
     * budget), the MCP servers tasks may get, the memory helper resolution,
     * each runtime's isolation options and the tool-authorization mode, plus
     * unknown-field warnings. Resolved once at construction; the same report
     * `byok-agent config check` prints.
     */
    config: DaemonEffectiveConfig;
}
export interface Daemon {
    /** Present only with agentMemoryExport: true. Holds the home writer lease; AgentHomeBusyError is retryable. Raw contents remain Host-owned. */
    exportAgentMemory?(agentRef: AgentRef, options?: AgentMemoryExportOptions): Promise<AgentMemoryExport>;
    /**
     * Pairing result is intentionally credential-blind. With
     * `verificationSecret`, the base32 secret the web client shows after the
     * pairing code (#654 §7.2), the device also enrolls as an E2EE member; the
     * secret never reaches the Host. Without it the device pairs without E2EE.
     *
     * Pairing refuses with `DeviceStoreBindingMismatchError`
     * (`device_store_not_bound`) while the OS credential entry of this
     * productId holds an enrollment this storeDir did not pair.
     * `replaceOtherStore: true` is the operator's explicit intent to replace
     * that enrollment; the other store then reads as not bound.
     */
    pair(pairingCode: string, options?: {
        readonly verificationSecret?: string;
        readonly replaceOtherStore?: boolean;
    }): Promise<DeviceEnrollment>;
    /**
     * Resolves once local startup is done — store ownership, storage, journal
     * recovery, the control socket and the task runner — with the reconnect
     * loop running. It does not wait for the server: `status().lifecycle` and
     * `lifecycle` events report the connection, and a halt the server causes.
     * Throws {@link DaemonHaltError} for a halt found locally; any other throw
     * is a crash.
     */
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
     * Approve, from the Host process that embeds this daemon, the pending
     * approval `approvalId` of a task — the same resolution a server-sent
     * `task.approve` makes (`TaskRunner.handleApprove`), reported to the server
     * as `task.approval_resolved`. Unlike the control socket's
     * `approvals.resolve`, it also approves a `tool-authorization` approval
     * whatever {@link DaemonConfig.localToolApproval} says. The session that
     * requested it through its `approvalChannel` (or a control-socket
     * `approvals.request`) receives `{ approved: true }`. A no-op (resolves
     * immediately) for a `taskId` this daemon doesn't currently have active;
     * a different `approvalId` is a stale decision and changes nothing.
     */
    approve(taskId: string, opts: {
        approvalId: string;
    }): Promise<void>;
    /** M3-2a: same as {@link approve} but rejects — see that method's doc comment. */
    reject(taskId: string, opts: {
        approvalId: string;
        reason?: string;
    }): Promise<void>;
}
/** Custom adapter composition. Available custom descriptors are published through
 * the capability-gated harness inventory; built-in RuntimeId remains closed. */
export interface DaemonOverrides {
    /**
     * Explicit enrollment-custody dependency. The caller owns its secret storage
     * and lifetime; omission composes the platform OS credential store.
     */
    deviceCredentials?: import('./device-credential-store').DeviceCredentialBackend;
    retention?: {
        clock?: () => Date;
        timers?: RetentionTimers;
        freeBytesProvider?: () => Promise<number>;
    };
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
     * A durable local journal the host supplies instead of `SqliteLocalTaskJournal`
     * (§12.7.2). It must meet the same contract (a resolved `appendEnvelope` is
     * fsynced); the daemon does not check that. `stop()` does not close it:
     * whoever injected it owns its lifetime.
     */
    journal?: LocalTaskJournal;
    /** Test-only post-open SQLite initialization fault seam. */
    journalOpenFaults?: JournalOpenFaultSeam;
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
export declare function createDaemon(config: DaemonConfig, overrides?: DaemonOverrides): Daemon;
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
 * brand new `deviceId` (see `packages/cloud/src/auth/plane.ts`), including on a
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
/**
 * #1121: the cursor file exists but holds no usable cursor, or cannot be read.
 * Never read as "no cursor": a missing cursor means a fresh device, and a
 * fresh device must not be inferred from a damaged store. Startup halts with
 * `cursor_unreadable`; the operator resets the cursor with
 * `byok-agent doctor --repair reset-cursor --yes` (or `resetDeviceCursor`).
 */
export declare class CursorUnreadableError extends Error {
    constructor(options?: {
        cause?: unknown;
    });
}
export declare class CursorStore {
    private readonly storeDir;
    constructor(storeDir: string);
    private fileFor;
    /**
     * `undefined` only when no cursor file exists. A file that cannot be read,
     * or that holds anything but a nonnegative integer cursor (the same guard
     * the server applies to `GET /byok/events?cursor=`), throws
     * {@link CursorUnreadableError}.
     */
    load(serverUrl: string, deviceId: string): Promise<number | undefined>;
    save(serverUrl: string, deviceId: string, cursor: number): Promise<void>;
    /** Remove any persisted cursor for (serverUrl, deviceId) — a no-op if none exists. Called from `pair()` (finding F5) so a device that's about to be replaced never leaves a cursor a future, unrelated device could somehow inherit. */
    clear(serverUrl: string, deviceId: string): Promise<void>;
}
// ==== @byok-sdk/client dist/daemon/daemon-errors.d.ts ====
import type { DeviceMetadata } from './device-credential-store';
/**
 * A `DaemonConfig` field that no longer exists was supplied. Construction
 * refuses it rather than ignoring it, so a host upgrading across a removal
 * learns at startup which seam is gone instead of silently losing behavior.
 */
export declare class DaemonConfigFieldRemovedError extends Error {
    /** The removed path, e.g. `resultDocument` or `agentEgress.sanitizer`. */
    readonly field: string;
    /** Repo-relative `.md#anchor` of the migration note (#1094). */
    readonly migration: string;
    readonly code: 'daemon_config_field_removed';
    constructor(
    /** The removed path, e.g. `resultDocument` or `agentEgress.sanitizer`. */
    field: string, message: string, 
    /** Repo-relative `.md#anchor` of the migration note (#1094). */
    migration: string);
}
/**
 * `resolveHostLayout` got an input it cannot build a layout from: a product
 * identifier that is not one portable path segment, a home directory that is
 * not absolute, or a platform without a layout. Fix the named `field` and
 * call it again; the call has no side effects.
 */
export declare class HostLayoutInputError extends Error {
    /** The `HostLayoutOptions` field: `productId`, `productName`, `homeDir` or `platform`. */
    readonly field: 'productId' | 'productName' | 'homeDir' | 'platform';
    readonly code: 'host_layout_input_invalid';
    constructor(
    /** The `HostLayoutOptions` field: `productId`, `productName`, `homeDir` or `platform`. */
    field: 'productId' | 'productName' | 'homeDir' | 'platform', message: string);
}
export type DaemonJournalProtocolRecord = 'recovery-offer' | 'pending-terminal';
/**
 * The local journal holds envelope bytes of another wire major. This daemon
 * has no reader for them, so startup stops before it writes, rewrites or
 * deletes any journal row: an operator drains or removes the old journal
 * with the release that wrote it (drain-then-upgrade).
 */
export declare class DaemonJournalProtocolUnsupportedError extends Error {
    readonly taskId: string;
    readonly record: DaemonJournalProtocolRecord;
    readonly found: unknown;
    readonly expected: number;
    readonly code: 'daemon_journal_protocol_unsupported';
    constructor(taskId: string, record: DaemonJournalProtocolRecord, found: unknown, expected?: number);
}
/**
 * Classify stored envelope bytes by wire major only. Bytes that are not a
 * JSON object are left to the regular decoder, which reports them as it
 * always did; this check never repairs or reinterprets a row.
 */
export declare function assertJournalEnvelopeProtocol(bytes: string, taskId: string, record: DaemonJournalProtocolRecord): void;
/**
 * The OS credential entry, keyed by productId alone, holds an enrollment
 * that this storeDir's `device.json` does not name: another storeDir of the
 * same productId paired it, or this store's projection is missing or from a
 * different pairing. Nothing adopts it. Recovery is an explicit operator act:
 * the doctor `restore-enrollment-metadata` action when this store owns the
 * enrollment, or a pair of this store under its own productId (#1094).
 */
export declare class DeviceStoreBindingMismatchError extends Error {
    readonly code: 'device_store_not_bound';
    /** The enrollment the OS entry holds. Identifiers only, never credential bytes. */
    readonly stored: {
        readonly deviceId: string;
        readonly tenantId: string;
    };
    /** The enrollment this storeDir's `device.json` names, if any. */
    readonly bound: {
        readonly deviceId: string;
        readonly tenantId: string;
    } | undefined;
    constructor(stored: DeviceMetadata, bound: DeviceMetadata | undefined);
}
// ==== @byok-sdk/client dist/daemon/daemon-lifecycle.d.ts ====
/**
 * The daemon's one lifecycle model (issues #391 and #394).
 *
 * `start()` resolves once local startup is done; whether the server has
 * accepted this device is a network fact, reported here and nowhere else. A
 * condition that a restart cannot fix ends the run as `halted` with a reason
 * from one closed set, whether it is found 100 ms or 10 days after start.
 */
/** Why a daemon run ended and must not be restarted automatically. Closed set. */
export declare const DAEMON_HALT_REASONS: readonly [
/** No device record: `pair` first. */
'unpaired', 
/** The device record on disk is unusable and only a fresh `pair` replaces it. */
're_pair_required', 
/** The OS enrollment of this productId was not paired by this storeDir (`device_store_not_bound`). */
'store_not_bound', 
/** Another daemon owns this store. Thrown by `start()`; never reported through `lifecycle`. */
'store_owned', 
/** The server revoked this device. */
'device_revoked', 
/** The server answered this device's `conn.hello` with a rejection. */
'handshake_rejected', 
/** The server no longer retains the history after this device's acknowledged cursor. */
'replay_cursor_too_old', 
/** The durable delivery cursor file is unreadable: run `doctor --repair reset-cursor`. */
'cursor_unreadable', 
/** The configuration cannot work; a restart with the same configuration fails the same way. Thrown by `start()`; never reported through `lifecycle`. */
'config_invalid'];
export type DaemonHaltReason = (typeof DAEMON_HALT_REASONS)[number];
export declare function isDaemonHaltReason(value: unknown): value is DaemonHaltReason;
/**
 * - `stopped`: not started, or stopped normally.
 * - `awaiting-enrollment`: a service-enrollment daemon waiting for its first `enrollment.pair`.
 * - `running`: local startup is done; `connection` is `open` once the server
 *   accepted this run's `conn.hello` and `connecting` otherwise.
 * - `halted`: the run ended on a {@link DaemonHaltReason}. It stays halted
 *   (also after `stop()`) until the next `start()`.
 * - `crashed`: the run ended on an unexpected error after `start()` resolved
 *   (an observer callback or the reconnect loop threw). The connection
 *   stops and a `lifecycle` operational-health failure is recorded; unlike a
 *   halt, a restart may fix it, so `byok-agent start` exits 1 and the OS
 *   supervisor restarts it. It stays crashed (also after `stop()`) until the
 *   next `start()`.
 */
export type DaemonLifecycle = {
    phase: 'stopped';
} | {
    phase: 'awaiting-enrollment';
} | {
    phase: 'running';
    connection: 'connecting' | 'open';
} | {
    phase: 'halted';
    reason: DaemonHaltReason;
    at: string;
} | {
    phase: 'crashed';
    at: string;
};
/**
 * `start()` throws this for a halt it finds locally. `store_owned` and
 * `config_invalid` are found before this process owns the store, so they
 * leave `lifecycle` unchanged: the run they describe never began, and the
 * store's owner (if any) is still the authority on its own lifecycle. Every
 * other reason is also reported as `lifecycle.halted`.
 */
export declare class DaemonHaltError extends Error {
    readonly reason: DaemonHaltReason;
    constructor(reason: DaemonHaltReason, options?: {
        cause?: unknown;
    });
}
/**
 * Strict read of a persisted or transported {@link DaemonLifecycle} (an
 * `audit.jsonl` line, a control `status` answer). Anything outside the closed
 * shape is `undefined`: an unreadable value is reported as unknown, never
 * guessed.
 */
export declare function parseDaemonLifecycle(value: unknown): DaemonLifecycle | undefined;
/**
 * What a liveness probe may conclude from a lifecycle, in one place: `up` is
 * a run that owns its store and answers on its control endpoint — `running`,
 * or `awaiting-enrollment` for a service-enrollment daemon that has not
 * paired yet, which is legitimately up rather than broken (#1097); `ended`
 * is a run that stopped or cannot continue; `starting` is `stopped`, which
 * a start in progress also reports until it resolves.
 */
export declare function daemonLifecycleHealth(lifecycle: DaemonLifecycle): 'up' | 'starting' | 'ended';
// ==== @byok-sdk/client dist/daemon/daemon-record.d.ts ====
import type { ToolAuthorizationReason, ToolFileAccess, ToolRiskReason } from '../tool-authorization';
import type { DaemonLifecycle } from './daemon-lifecycle';
import { type AssertionLane, type DaemonEvent } from './observer';
import { type ServiceEnvironmentStatus, type ServiceEnvironmentRecord } from '../login-shell-environment';
import type { RuntimeObservation } from '../runtime-detection';
/**
 * The content-free projection of what a daemon observed — the ONE shape every
 * sink that outlives the process writes (issue #395): `byok-agent start`'s
 * stdout (a service log under launchd/systemd/WinSW) and `audit.jsonl` hold the
 * same JSON line per record.
 *
 * A record carries lifecycle facts, ids, closed codes, configured identifiers
 * (runtime/tool/toolset ids, the assertion audience allowlist), sizes, counts
 * and timestamps — never content. Every free-form field of a `DaemonEvent`
 * (model text, tool input/output, artifact names and bytes, approval summaries,
 * completed summaries, failure/cancel/shutdown/disposal reasons) becomes its
 * UTF-8 byte count (`*Bytes`). `DaemonEvent` itself, with full content, is only
 * for authenticated live views (the control socket's `tasks.subscribe`).
 *
 * Progress is aggregated per turn: a task's `progress` events produce one
 * `turn` record when the runtime reports `turn_end`, or when the turn is still
 * open as the task ends, the daemon stops, or the task is evicted.
 */
export type DaemonRecord = Extract<DaemonEvent, {
    kind: 'outbound-rejected';
}> | Extract<DaemonEvent, {
    kind: 'retention-sweep' | 'retention-failure';
}> | {
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
} | DaemonTurnRecord | {
    kind: 'artifact';
    ts: string;
    taskId: string;
    nameBytes: number;
    contentType: string;
    inlineBytes?: number;
    blobRef?: {
        blobId: string;
        contentHash: string;
        size: number;
    };
} | {
    kind: 'awaiting-approval';
    ts: string;
    taskId: string;
    approvalId?: string;
    summaryBytes: number;
} | {
    kind: 'completed';
    ts: string;
    taskId: string;
    sessionRef: string;
    summaryBytes: number;
} | {
    kind: 'failed';
    ts: string;
    taskId: string;
    retryable: boolean;
    preClaim?: boolean;
    reasonBytes: number;
} | {
    kind: 'cancelled';
    ts: string;
    taskId: string;
    reasonBytes?: number;
} | {
    kind: 'lifecycle';
    ts: string;
    lifecycle: DaemonLifecycle;
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
    runtimes: Array<Omit<RuntimeObservation, 'version' | 'versionVerdict' | 'versionChange' | 'executablePath' | 'executableSource'>>;
} | {
    kind: 'shutdown-requested';
    ts: string;
    reasonBytes: number;
} | {
    kind: 'shutdown-complete';
    ts: string;
    reasonBytes: number;
    undeliveredOutboxCount?: number;
} | {
    kind: 'stale-approval-decision';
    ts: string;
    taskId: string;
    decision: 'approve' | 'reject';
    reasonBytes?: number;
} | {
    kind: 'tool-reminder';
    ts: string;
    taskId: string;
    reasons: readonly ToolRiskReason[];
    suppressedReasons?: readonly ToolRiskReason[];
    authorization: ToolAuthorizationReason;
    summaryBytes: number;
} | Omit<Extract<DaemonEvent, {
    kind: 'tool-authorization';
}>, 'toolName'>
/**
 * #1061 D12: local deny/adoption audit. Already content-free — closed codes,
 * root ids and a digest; no path, command or file content.
 */
 | {
    kind: 'file-scope';
    ts: string;
    taskId: string;
    decision: 'deny' | 'policy-adoption';
    lane: 'rpc' | 'prepared' | 'durable';
    homeAccess: 'writer' | 'memory-reader';
    scope: {
        source: 'host';
        mode: 'home' | 'workspaces';
        digest: string;
    };
    rootIds?: readonly string[];
    rootId?: string;
    access?: ToolFileAccess;
    code?: 'file_scope_denied' | 'file_scope_unavailable' | 'file_scope_unsupported';
    reason?: string;
    toolName?: string;
    toolCallId?: string;
} | {
    kind: 'runtime-disposal-failed';
    ts: string;
    taskId: string;
    runtimeId: string;
    stage: 'signal' | 'quiescence' | 'cleanup';
    reasonBytes: number;
}
/** Already content-free: counts and closed codes (`execution-record.ts`). */
 | Extract<DaemonEvent, {
    kind: 'execution-record';
}> | {
    kind: 'agent-memory-intent-integrity';
    ts: string;
    intentId: string;
    disposition: 'conflict' | 'host_terminal';
} | {
    kind: 'device-assertion';
    ts: string;
    result: 'issued';
    lane: AssertionLane;
    taskId?: string;
    audience: string;
    jti: string;
    expiresAt: string;
} | {
    kind: 'device-assertion';
    ts: string;
    result: 'denied';
    lane: AssertionLane;
    taskId?: string;
    reason: string;
    audienceBytes?: number;
}
/** Written by the process hosting the daemon (`byok-agent start`): where its environment came from (issue #392). */
 | ({
    kind: 'environment-resolved';
    ts: string;
} & ServiceEnvironmentStatus)
/** Written by the process hosting the daemon once `start()` resolved. */
 | {
    kind: 'daemon-started';
    ts: string;
    productId: string;
}
/** Written by the process hosting the daemon once `stop()` resolved. */
 | {
    kind: 'daemon-stopped';
    ts: string;
};
/** One turn of a task's progress, as sizes and counts. */
export interface DaemonTurnRecord {
    kind: 'turn';
    ts: string;
    taskId: string;
    /** 1-based turn number within the task, as this projector counted it. */
    turn: number;
    /** What closed the record: the runtime's `turn_end`, or a still-open turn at the task's terminal, the daemon's stop, or eviction. */
    closedBy: 'turn_end' | 'terminal' | 'stop' | 'evicted';
    /** Every `AgentEvent` of the turn, `turn_end` and `usage` included. */
    progressEvents: number;
    textBytes: number;
    toolUses: number;
    toolResults: number;
    artifacts: number;
    errors: number;
    /** The turn's last `usage` report, when it had one. */
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
}
export type DaemonRecordKind = DaemonRecord['kind'];
/** Every {@link DaemonRecord} kind — the one list readers (the support bundle, the audit reader) accept. */
export declare const DAEMON_RECORD_KINDS: readonly DaemonRecordKind[];
export declare function isDaemonRecordKind(value: unknown): value is DaemonRecordKind;
export interface DaemonRecordProjector {
    /** The records `event` produces, in order: none (a progress event inside an open turn), one, or two (an open turn closed by a terminal). */
    project(event: DaemonEvent): DaemonRecord[];
    /** Closes every open turn (`closedBy: 'stop'`) — call once the daemon has stopped. */
    flush(ts: string): DaemonRecord[];
}
/** The one closed environment shape, shared by projection and persistent/live readers. */
export declare function parseEnvironmentRecord(value: unknown): ServiceEnvironmentRecord | undefined;
/**
 * A stateful `DaemonEvent` → {@link DaemonRecord} projector. One per event
 * stream: it holds each task's open turn until the turn closes.
 */
export declare function createDaemonRecordProjector(): DaemonRecordProjector;
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
/**
 * How many times an automatic retry delay doubles before it stops growing:
 * the ceiling is `baseMs × 2^MAX_BACKOFF_DOUBLINGS` (64 s for the 2 s default).
 * The ceiling scales with the caller's base so a short test base keeps a short
 * ceiling.
 */
export declare const MAX_BACKOFF_DOUBLINGS = 5;
/**
 * The capped exponential schedule every automatic retry loop on the device
 * uses: `baseMs × 2^attempt`, flat from attempt {@link MAX_BACKOFF_DOUBLINGS}.
 * Attempt 0 is the first retry after a failure; callers reset to 0 on success.
 */
export declare function backoffCeilingMs(attempt: number, baseMs: number): number;
export type FleetBackoffDomain = Exclude<JitterDomain, 'maintenance'>;
export interface FleetJitter {
    /**
     * The delay before retry `attempt` (0-based, reset on success): the capped
     * exponential {@link backoffCeilingMs}, spread ±20% by the identity's
     * deterministic jitter. Jitter is applied after the cap, so a fleet parked
     * at the ceiling still retries spread out rather than in lockstep.
     */
    delay(domain: FleetBackoffDomain, attempt: number, baseMs: number): number;
}
export declare function createFleetJitter(productId: string, deviceId: string): FleetJitter;
// ==== @byok-sdk/client dist/daemon/device-credential-store.d.ts ====
/** Secret fields inside the internal complete enrollment authority. */
export interface DeviceCredentials {
    readonly accessToken: string;
    /**
     * Device-local expiry of `accessToken` (#1114): this device's receipt time
     * plus the server's relative `expiresIn`. It is compared only with this
     * device's clock, never with a server timestamp.
     */
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
/**
 * Runs one provider command. On `signal` abort the runner kills the child and
 * rejects at once, without waiting for its pipes to close.
 */
export type DeviceCommandRunner = (executable: string, args: readonly string[], stdin?: string, signal?: AbortSignal) => Promise<DeviceCommandResult>;
/** The Windows generic-credential blob bound, kept on every OS entry of this product. */
export declare const OS_CREDENTIAL_ENTRY_MAX_BYTES = 2400;
/** Typed unavailability; callers must surface re-pair/operational failure, never write a file fallback. */
export declare class DeviceCredentialStoreUnavailableError extends Error {
    constructor(message?: string);
}
export declare class DeviceCredentialStoreError extends Error {
    constructor(message: string);
}
/** macOS refused an operation that requires unavailable user interaction. */
export declare class DeviceCredentialInteractionRequiredError extends DeviceCredentialStoreError {
    constructor();
}
/**
 * A provider command ended before it answered: it exceeded its deadline, or
 * the caller cancelled it (daemon shutdown). The child process was killed.
 * Nothing was learned about the entry, so the caller keeps its prior state.
 */
export declare class DeviceCredentialCommandAbortedError extends DeviceCredentialStoreError {
    readonly reason: 'deadline' | 'cancelled';
    constructor(reason: 'deadline' | 'cancelled');
}
/**
 * Complete enrollment custody. An injected implementation owns secret storage
 * and its lifetime. `signal` cancels the operation (daemon shutdown); an
 * implementation must stop and reject once it aborts.
 * Staging an attempt preserves the current enrollment returned by `read()`.
 * `replace()` retains that attempt when renewing the same deviceId, tenantId
 * and devicePublicKey; a different authenticated enrollment promotes the
 * replacement and discards the attempt. `clear()` removes both authorities.
 */
export interface DeviceCredentialBackend {
    read(signal?: AbortSignal): Promise<DeviceRecord | undefined>;
    readFirstPairingAttempt(signal?: AbortSignal): Promise<FirstPairingAttempt | undefined>;
    saveFirstPairingAttempt(attempt: FirstPairingAttempt, signal?: AbortSignal): Promise<void>;
    replace(record: DeviceRecord, signal?: AbortSignal): Promise<void>;
    clear(signal?: AbortSignal): Promise<boolean>;
}
export interface DeviceCredentialConfig {
    /** Explicit macOS keychain file; omitted uses the operating system's default keychain. */
    readonly macosKeychainPath?: string;
}
export interface OsCredentialEntryOptions extends DeviceCredentialConfig {
    readonly storeDir: string;
    readonly productId: string;
    readonly platform?: NodeJS.Platform;
    readonly commandRunner?: DeviceCommandRunner;
    /** Internal test seam for the per-command deadline; production uses the fixed bound. */
    readonly commandDeadlineMs?: number;
}
/**
 * One named entry of this product's OS credential provider: the macOS
 * keychain, the Windows Credential Manager or the Linux Secret Service. It
 * moves raw strings; each owner encodes and checks its own value. An explicit
 * macOS keychain selects custody within that provider, without a file
 * fallback.
 */
export declare class OsCredentialEntry {
    #private;
    constructor(options: OsCredentialEntryOptions & {
        readonly account: string;
        readonly label: string;
        readonly subject: string;
    });
    /** The stored value, or `undefined` when the entry is absent. */
    read(signal?: AbortSignal): Promise<string | undefined>;
    replace(value: string, signal?: AbortSignal): Promise<void>;
    /** Delete the entry. An absent entry is already deleted. */
    delete(signal?: AbortSignal): Promise<void>;
}
/**
 * Internal OS-backed authority for the bearer token and device private key,
 * in the entry `device-enrollment`.
 */
export declare class DeviceCredentialStore implements DeviceCredentialBackend {
    #private;
    constructor(options: OsCredentialEntryOptions);
    read(signal?: AbortSignal): Promise<DeviceRecord | undefined>;
    readFirstPairingAttempt(signal?: AbortSignal): Promise<FirstPairingAttempt | undefined>;
    saveFirstPairingAttempt(attempt: FirstPairingAttempt, signal?: AbortSignal): Promise<void>;
    replace(record: DeviceRecord, signal?: AbortSignal): Promise<void>;
    /** Returns true only after the sole secret authority is confirmed absent. */
    clear(signal?: AbortSignal): Promise<boolean>;
}
export declare function runDeviceCommand(executable: string, args: readonly string[], stdin?: string, signal?: AbortSignal): Promise<DeviceCommandResult>;
// ==== @byok-sdk/client dist/daemon/device-proof-signer.d.ts ====
import { type DeviceProofEnvelopeV1 } from '@byok-sdk/core';
import type { AuthManager } from './auth-manager';
import { type DeviceEnrollmentIdentity } from './store';
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
declare const HOST_SIGNER_MESSAGES: {
    readonly invalid_options: 'The device proof signer requires a product, the exact enrollment identity and a non-empty operation allowlist.';
    readonly operation_not_allowed: 'The requested device proof operation is not in this signer\'s operation allowlist.';
    readonly invalid_request: 'The device proof request is not a valid request binding.';
    readonly unpaired: 'The device is not paired; no device proof can be signed.';
    readonly re_pair_required: 'The device enrollment requires an explicit re-pair; no device proof can be signed.';
    readonly enrollment_changed: 'The current device enrollment differs from the identity this signer was created for.';
    readonly enrollment_unavailable: 'The device enrollment could not be read safely; no device proof was signed.';
    readonly signing_failed: 'The device proof could not be signed.';
};
export type DeviceProofSignerErrorCode = keyof typeof HOST_SIGNER_MESSAGES;
/**
 * Closed-code failure of a host device-proof signer. It never carries a cause,
 * OS diagnostic, path or key material.
 */
export declare class DeviceProofSignerError extends Error {
    readonly code: DeviceProofSignerErrorCode;
    constructor(code: DeviceProofSignerErrorCode);
}
export interface CreateStoredDeviceProofSignerOptions {
    readonly productId: string;
    /** Same OS keychain selection as the daemon and enrollment identity read. */
    readonly deviceCredentials?: import('./device-credential-store').DeviceCredentialConfig;
    /** Same store directory the daemon uses; omitted resolves the product default. */
    readonly storeDir?: string;
    /**
     * The exact enrollment identity the host read with
     * `readDeviceEnrollmentIdentity`. Every signature re-reads the enrollment and
     * refuses (`enrollment_changed`) when tenant, device or proof key differ, so
     * a re-pair between read and sign can never sign for a different device.
     */
    readonly identity: Pick<DeviceEnrollmentIdentity, 'tenantId' | 'deviceId' | 'proofKeyId' | 'proofKeyEpoch'>;
    /**
     * Host-defined device-proof operations this signer may sign (for example
     * `provider-secret-sealing-key.register`). Any other operation is refused
     * before the enrollment key is read.
     */
    readonly operations: readonly string[];
    readonly clock?: () => Date;
}
/** A {@link DeviceProofSigner} scoped to one enrollment identity and an explicit operation allowlist. */
export interface HostDeviceProofSigner extends DeviceProofSigner {
    /** The frozen allowlist this signer was created with. */
    readonly operations: readonly string[];
}
/**
 * Create a host device-proof signer backed by the stored enrollment key.
 *
 * The signer holds no key material: each `sign` validates the operation and
 * request binding, reads the current OS enrollment authority, checks it equals
 * `identity`, signs core's canonical device-proof bytes (method, path, body
 * SHA-256 and size, operation, resource, request id, time window) with the
 * Ed25519 enrollment key and returns only the envelope. The private key is
 * never returned, cached, logged or attached to an error.
 *
 * Security boundary: the allowlist scopes one signer instance; it is not a
 * sandbox. Any code running as the device's OS account can already use the
 * enrollment key, and verifiers must still bind operation, resource and body
 * to their own route (as `@byok-sdk/cloud` `authenticateDeviceProof` does).
 */
export declare function createStoredDeviceProofSigner(options: CreateStoredDeviceProofSignerOptions): HostDeviceProofSigner;
export {};
// ==== @byok-sdk/client dist/daemon/execution-record.d.ts ====
import type { AgentEvent } from '@byok-sdk/protocol';
import type { RuntimeAdapterDescriptor, Session } from '../types';
/**
 * Octop ③ (#553): a local, content-free diagnostic that says whether the SDK
 * saw the whole event trajectory of one started execution. `TaskRunner`
 * publishes it after the semantic terminal is committed, and it never changes
 * that terminal: not its type, not `retryable`, not outcome application, and
 * it never starts a retry.
 *
 * - `complete`: the adapter declares an evidence source, every tool call has
 *   exactly one result, no frame was dropped or invented, and the runtime sent
 *   `turn_end`. It is about collection only; a failed task can be complete.
 * - `partial`: a declared source with at least one gap.
 * - `unknown`: no declared source, or more open tool calls than the record
 *   tracks. A Host that has no record for a terminal also shows `unknown`.
 */
export type ExecutionRecordStatus = 'complete' | 'partial' | 'unknown';
/**
 * Why a declared record is not complete. A record lists only the gaps it saw,
 * each with its count.
 *
 * - `unpaired_tool_call`: a `tool_use` with no result when the terminal was
 *   decided, with no `toolCallId`, or with an id that was already used.
 * - `orphan_tool_result`: a `tool_result` with no `toolCallId`, or for an id
 *   that no open call had.
 * - `duplicate_tool_result`: a second result for an answered id.
 * - `synthetic_tool_result`: a result the adapter made itself ({@link Session.evidence}).
 * - `decode_dropped`: runtime output the adapter could not decode ({@link Session.evidence}).
 * - `unmapped_frame`: runtime frames of an unexpected type ({@link Session.evidence}).
 * - `stream_ended_early`: the runtime ended or failed its event stream before `turn_end`.
 * - `no_turn_end`: the daemon decided the terminal (cancel, reject, limit,
 *   shutdown) before `turn_end`.
 * - `spill_unstored`: a tool input or output too large to travel inline whose
 *   full bytes could not be stored (`spill.unstoredReason`).
 */
export type ExecutionRecordGap = 'unpaired_tool_call' | 'orphan_tool_result' | 'duplicate_tool_result' | 'synthetic_tool_result' | 'decode_dropped' | 'unmapped_frame' | 'stream_ended_early' | 'no_turn_end' | 'spill_unstored';
/** Why a record is `unknown`. */
export type ExecutionRecordUnknown = 'source_not_declared' | 'evidence_overflow';
/** One started execution's record. Counts and closed codes only: never a tool input, output, path or reason text. */
export interface ExecutionRecord {
    taskId: string;
    terminal: 'complete' | 'failed' | 'cancelled';
    status: ExecutionRecordStatus;
    source: 'event-stream' | 'none';
    gaps: Array<{
        reason: ExecutionRecordGap;
        count: number;
    }>;
    unknownReason?: ExecutionRecordUnknown;
}
/** Open tool calls one execution tracks. One more makes its record `unknown` (`evidence_overflow`). */
export declare const MAX_OPEN_TOOL_CALLS = 4096;
/**
 * Builds one execution's record from the events `TaskRunner.pump` accepts for
 * the task, before they are batched. In memory only, and it never awaits. It
 * stops at the terminal decision, because the pump stops passing it events
 * there. The adapter counts it reads at `finish` cover the whole session up to
 * `Session.close()`, so a frame cut short while the runtime shuts down is a
 * gap too.
 */
export declare class ExecutionRecordAccumulator {
    private readonly taskId;
    private readonly source;
    private readonly session;
    private readonly open;
    /** The latest answered ids, kept only to tell a repeated result from an orphan. Bounded like `open`. */
    private readonly answered;
    private readonly counts;
    private turnEnded;
    private streamEndedEarly;
    private overflowed;
    constructor(taskId: string, source: RuntimeAdapterDescriptor['trajectoryEvidence'], session: Pick<Session, 'evidence'>);
    observe(event: AgentEvent): void;
    /** The runtime ended or failed its event stream on its own, before the daemon decided a terminal. */
    streamEnded(): void;
    /** Reads `Session.evidence()` once, so call it after `Session.close()` resolved. */
    finish(terminal: ExecutionRecord['terminal']): ExecutionRecord;
    private openCall;
    private answerCall;
}
// ==== @byok-sdk/client dist/daemon/host-layout.d.ts ====
/** Platforms `resolveHostLayout` has a layout for. */
export type HostLayoutPlatform = 'darwin' | 'linux' | 'win32';
export interface HostLayoutOptions {
    /** `DaemonConfig.productId`. Names the SDK store: `<home>/.byok/<productId>`; on Linux also the Host root. */
    readonly productId: string;
    /** `DaemonConfig.productName`. Names the Host root on macOS and Windows, e.g. `Salesko`. */
    readonly productName: string;
    /** Default: `process.platform`. */
    readonly platform?: NodeJS.Platform;
    /** The user's home directory. Default: `os.homedir()`. */
    readonly homeDir?: string;
    /** Reads `XDG_DATA_HOME` (Linux) and `LOCALAPPDATA` (Windows). Default: `process.env`. */
    readonly env?: Readonly<Record<string, string | undefined>>;
}
/**
 * The recommended local directories of one Host product on one platform
 * (#1094). Who owns what:
 *
 * - `storeDir` is the SDK's. Pass it as `DaemonConfig.storeDir`, or leave
 *   that field unset: the default is the same path.
 * - `hostStorageRoot` is the Host's. Pass it as `agentHome.hostStorageRoot`;
 *   the SDK composes `agentHomes` (`<hostStorageRoot>/agents`) and every
 *   `agents/<agentId>` under it. Keep Host files beside `agents/`, not in it.
 * - `logDir` is where `byok-agent service install` sends the daemon's stdout
 *   and stderr.
 * - The Host keeps its config file and its own state outside `storeDir`.
 */
export interface HostLayout {
    readonly platform: HostLayoutPlatform;
    readonly storeDir: string;
    /**
     * Where execution scratch goes with this `storeDir` and no
     * `storage.scratchRoot` (#493). `store`: `<storeDir>/tmp` fits the runtime
     * Unix socket budget. `short-root`: it does not, so the daemon moves
     * scratch to a fixed short root keyed by the store path. Computed from the
     * lexical path; a symbolic link in an existing ancestor can change it, and
     * `byok-agent config check` reports the value a daemon resolves.
     */
    readonly scratchRoot: {
        readonly path: string;
        readonly source: 'store' | 'short-root';
        readonly socketPathBytes: number;
        /** Absent on Windows, which has no socket path limit. */
        readonly socketPathMaximumBytes?: number;
    };
    readonly hostStorageRoot: string;
    readonly agentHomes: string;
    readonly logDir: string;
}
/**
 * The SDK store directory a daemon uses when `DaemonConfig.storeDir` is
 * unset: `<homeDir>/.byok/<productId>` on every platform. `DeviceStore.resolveDir`
 * and `resolveHostLayout` both use it; it is the only definition.
 */
export declare function defaultStoreDir(productId: string, homeDir?: string, platform?: NodeJS.Platform): string;
/** Where `byok-agent service install` sends the daemon's stdout and stderr. */
export declare function serviceLogDir(storeDir: string, platform?: NodeJS.Platform): string;
/**
 * The recommended `storeDir`, `hostStorageRoot` and log directory for a Host
 * product (#1094), with the #493 scratch placement of that `storeDir`.
 * Pure: it reads no file and creates nothing, so a Host can call it for any
 * platform, e.g. in an installer or a test.
 *
 * `hostStorageRoot` follows each platform's convention for per-user
 * application data:
 *
 * - macOS: `~/Library/Application Support/<productName>`
 * - Linux: `$XDG_DATA_HOME/<productId>`, default `~/.local/share/<productId>`
 * - Windows: `%LOCALAPPDATA%\<productName>`, default `~\AppData\Local\<productName>`
 *
 * `storeDir` is the SDK default, `~/.byok/<productId>`, on every platform. It
 * is short on purpose: an application-data path is often too long for
 * runtime Unix sockets under `<storeDir>/tmp` (#493).
 *
 * @throws {HostLayoutInputError} `productId` or `productName` is not one
 * portable path segment, `homeDir` is not absolute, or the platform is not
 * macOS, Linux or Windows.
 */
export declare function resolveHostLayout(options: HostLayoutOptions): HostLayout;
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
 * A task-opening envelope above the inbound record bound (#826). Its bytes are
 * not stored: the journal keeps its identity, digest and length, the declined
 * task and the daemon's decline in one transaction, so the cursor can move
 * past it and the decline survives a crash.
 */
export interface WithheldOfferRecord {
    readonly identity: JournalIdentity;
    readonly envelopeId: string;
    readonly taskId: string;
    readonly seq: number;
    /** `sha256:<hex>` over the canonical bytes that were not stored. */
    readonly bytesHash: string;
    readonly byteLength: number;
    readonly receivedAt: string;
    /** The canonical `task.decline` of this task. Bounded like any terminal record. */
    readonly decline: {
        readonly bytes: string;
        readonly payloadHash: string;
    };
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
 * One canonical terminal and its delivery projection. Bytes are the replay
 * authority; the hash is checked against them, never used as a substitute.
 * The bytes change only when the cloud refused them
 * ({@link LocalTaskJournal.replaceRefusedTerminal}).
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
/** A task whose offer was withheld (#826). It is declined and has nothing to run or recover. */
export interface WithheldOfferTask extends Omit<RecoverableTask, 'envelopeBytes'> {
    /** Length of the canonical offer bytes that were not stored. */
    readonly withheldEnvelopeBytes: number;
}
/**
 * What recovery decided about a task. `interrupted` is the honest default for
 * a daemon restart: local runtime sessions do not survive the process, so the
 * task is recorded as interrupted rather than pretended back into life.
 * Nothing here deletes anything; a row that has been
 * through recovery carries a marker, and §12.7.2.1 forbids auto-deleting
 * those.
 */
export type RecoveryDisposition = 'resumed' | 'interrupted' | 'abandoned';
export interface RecoveryOutcome {
    readonly disposition: RecoveryDisposition;
    readonly reason?: string;
    readonly occurredAt?: string;
}
export interface LocalStorageUsage {
    readonly measuredAt: string;
    readonly journalBytes: number;
    readonly quarantineBytes: number;
    readonly journalEntries: number;
    readonly confirmedEntries: number;
    readonly oldestConfirmedAt?: string;
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
    /**
     * Make one over-bound task-opening envelope durable without its bytes, with
     * its task declined and the decline pending. Idempotent by envelope id like
     * {@link appendEnvelope}. Refuses a task whose stored offer could still run.
     */
    appendWithheldOffer(record: WithheldOfferRecord): Promise<JournalReceipt>;
    /** Record the admission decision for a task whose offer envelope is already durable. */
    recordAdmission(record: AdmissionRecord): Promise<void>;
    /** Record one local execution-state transition. Idempotent by transition id. */
    recordTransition(record: LocalTransitionRecord): Promise<void>;
    /** Record (or update the retry state of) a task's terminal. Idempotent by task id: a replay with the same payload hash is a no-op beyond retry bookkeeping. */
    recordTerminal(record: LocalTerminalRecord): Promise<void>;
    /** Exact original terminal bytes, including rejected records, until acknowledged. */
    listPendingTerminals(identity: JournalIdentity): Promise<LocalTerminalRecord[]>;
    /**
     * A successful authenticated transport disposition, bound to the original
     * bytes. A disposition of bytes that {@link replaceRefusedTerminal} replaced
     * changes nothing and must not throw: the daemon keeps the batch of a failed
     * disposition and posts it again.
     */
    confirmTerminal(taskId: string, payloadHash: string): Promise<void>;
    /** A refusal of the original bytes; the same rule as {@link confirmTerminal} for replaced bytes. */
    rejectTerminal(taskId: string, payloadHash: string, reason: string): Promise<void>;
    /**
     * Replace a terminal the cloud refused ({@link rejectTerminal}) with another
     * one, which becomes the pending terminal (#654 §77b). The cloud records
     * nothing for a refused terminal, so the replacement is the first terminal
     * it receives. Refuses a row that is not refused or names another hash.
     * Idempotent: a repeat whose bytes are already current changes nothing. The
     * replaced hash is kept as a transition of the task.
     */
    replaceRefusedTerminal(taskId: string, refusedPayloadHash: string, record: LocalTerminalRecord): Promise<void>;
    /** Includes old interruption markers without reports; they must not hide pending work. */
    listRecoveryTasks(identity: JournalIdentity): Promise<RecoverableTask[]>;
    readTask(taskId: string, identity: JournalIdentity): Promise<RecoverableTask | WithheldOfferTask | undefined>;
    /** Tasks with no terminal and no recovery marker — what this daemon was in the middle of when it last stopped. */
    listRecoverable(): Promise<RecoverableTask[]>;
    /** Close out one recoverable task by writing its recovery marker. Never deletes; a marked row is on §12.7.2.1's never-auto-delete list. */
    markRecovered(taskId: string, outcome: RecoveryOutcome): Promise<void>;
    /** Physical journal/quarantine footprint and logical receipt counts; retention registry owns aggregate usage. */
    measureUsage(): Promise<LocalStorageUsage>;
    /** Confirmed terminals older than cutoff, without recovery markers, oldest first. */
    listPrunableConfirmedTasks(cutoff: Date, limit: number): Promise<string[]>;
    /** Transactionally rechecks confirmation and recovery protection before pruning. */
    pruneConfirmedJournalTask(taskId: string): Promise<boolean>;
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
import { type JournalIdentity, type AdmissionRecord, type CompactOptions, type CompactResult, type JournalReceipt, type LocalStorageUsage, type LocalTaskJournal, type LocalTerminalRecord, type LocalTransitionRecord, type RecoverableTask, type RecoveryOutcome, type ReceivedEnvelopeRecord, type WithheldOfferRecord, type WithheldOfferTask } from './journal';
import { JournalHandleCleanupError, type JournalOpenFaultSeam } from '../../util/sqlite-support';
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
export type JournalFaultStep = 'append:before-begin' | 'append:after-envelope' | 'append:after-task' | 'append:after-receipt' | 'append:before-commit' | 'append:after-commit' | 'admission:before-commit' | 'transition:before-commit' | 'terminal:before-commit' | 'terminal:after-commit' | 'recovery:after-commit' | 'confirm:before-commit' | 'confirm:after-commit' | 'replace:before-commit' | 'replace:after-commit' | 'recovery:before-commit' | 'cleanup:before-commit' | 'prune:before-commit';
export interface JournalFaultSeam {
    /** Throw to simulate a crash or IO error at exactly this step. Return normally to proceed. */
    onStep?(step: JournalFaultStep): void;
}
export interface SqliteLocalTaskJournalOptions {
    /** The daemon's store directory. The database lives at `<storeDir>/daemon.db` and quarantine at `<storeDir>/quarantine/`. */
    readonly storeDir: string;
    /** Bound on waiting for the write lock. Default {@link DEFAULT_JOURNAL_BUSY_TIMEOUT_MS}. */
    readonly busyTimeoutMs?: number;
    /**
     * Per-record byte bound. Default {@link DEFAULT_MAX_RECORD_BYTES}. An inbound
     * envelope record may still reach a floor derived from the inline sealed
     * maximum (415083 bytes), so a sealed envelope can be journaled and declined.
     * A task-opening envelope above the bound is kept without its bytes and
     * declined ({@link SqliteLocalTaskJournal.appendWithheldOffer}, #826).
     */
    readonly maxRecordBytes?: number;
    /** Test seam — see {@link JournalFaultSeam}. Never supplied in production. */
    readonly faults?: JournalFaultSeam;
    /** Test seam for post-open/pre-return SQLite initialization failures. Never supplied in production. */
    readonly openFaults?: JournalOpenFaultSeam;
    /** Injected clock, so receipt/quarantine timestamps are deterministic under test. Defaults to the real one. */
    readonly clock?: () => Date;
}
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
    /** #826: the decline commits with the row, because the cursor moves once this commits. */
    appendWithheldOffer(record: WithheldOfferRecord): Promise<JournalReceipt>;
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
    readTask(taskId: string, identity: JournalIdentity): Promise<RecoverableTask | WithheldOfferTask | undefined>;
    listRecoveryTasks(identity: JournalIdentity): Promise<RecoverableTask[]>;
    listPendingTerminals(identity: JournalIdentity): Promise<LocalTerminalRecord[]>;
    confirmTerminal(taskId: string, payloadHash: string): Promise<void>;
    rejectTerminal(taskId: string, payloadHash: string, reason: string): Promise<void>;
    replaceRefusedTerminal(taskId: string, refusedPayloadHash: string, record: LocalTerminalRecord): Promise<void>;
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
    /** Physical journal/quarantine footprint and confirmed-row inventory. */
    measureUsage(): Promise<LocalStorageUsage>;
    listPrunableConfirmedTasks(cutoff: Date, limit: number): Promise<string[]>;
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
// ==== @byok-sdk/client dist/daemon/memory-guidance.d.ts ====
/**
 * Runtime-neutral instructions for an Agent's model-authored local memory.
 *
 * This is deliberately prompt guidance only: the SDK does not read memory
 * content, infer durable values, or auto-inject files into the operation.
 */
export declare const AGENT_MEMORY_GUIDANCE: string;
/**
 * Guidance for a `memory-reader` Attempt. Its `cwd` is its own run directory,
 * `<home>/.byok/runs/<taskId>/`, so the memory is three levels up. The writer
 * Attempt owns memory changes. This is guidance only: the SDK does not make
 * memory read-only, and the reader terminal reports any memory change.
 * Agent content reads do not reach the run directory (it is under `.byok/`),
 * so the guidance puts the result in the final reply, not in a file.
 */
export declare const AGENT_MEMORY_READER_GUIDANCE: string;
export declare function prependAgentMemoryGuidance(instruction: string): string;
export declare function prependAgentMemoryReaderGuidance(instruction: string): string;
/**
 * A `memory-reader` Attempt on a daemon with `agentMemoryMcp: 'off'`: no memory
 * lines, only the run-directory result guidance.
 */
export declare function prependAgentReaderResultGuidance(instruction: string): string;
/**
 * The guidance for the effective memory mode of an ordinary Agent task (#614).
 * `none` gets no memory lines; a reader keeps its result line. `read` gets
 * read-only guidance. `read-write` gets the writer guidance; a reader never
 * gets this mode.
 */
export declare function prependAgentMemoryModeGuidance(instruction: string, mode: 'none' | 'read' | 'read-write', reader: boolean): string;
// ==== @byok-sdk/client dist/daemon/observer.d.ts ====
import type { RetentionClassId, RetentionTrigger, SweepReport } from './retention/registry';
import type { ToolAuthorizationDecision, ToolFileAccess, ToolReminder } from '../tool-authorization';
import { type AgentEvent, type BlobRef, type Envelope, type OfferAdmissionTimings, type TaskState } from '@byok-sdk/protocol';
import type { DaemonLifecycle } from './daemon-lifecycle';
import type { ExecutionRecord } from './execution-record';
import type { RuntimeObservation } from '../runtime-detection';
import type { ServiceEnvironmentStatus } from '../login-shell-environment';
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
 *   runner?.handleEnvelope(envelope)`, `(state) => setLifecycle(...)`).
 *   `onEnvelope` additionally exposes the raw INBOUND offer variants — the
 *   one event class with no corresponding outbound envelope of its own — see
 *   `handleInboundEnvelope`.
 *
 * Neither seam required adding anything to `TaskRunnerDeps`/`TaskRunner`
 * itself: both were already plain functions `create-daemon.ts` constructs,
 * so wrapping them (call this module first, then the real behavior,
 * unchanged) is the entire integration.
 */
/** Every local event kind this daemon can emit — see {@link DaemonEvent}. */
export type DaemonEventKind = DaemonEvent['kind'];
import type { OutboundRejection } from './outbound-settlement';
export type DaemonEvent = ({
    kind: 'outbound-rejected';
    ts: string;
} & OutboundRejection & ({
    terminal: true;
    taskState: TaskState;
} | {
    terminal: false;
})) | ({
    kind: 'retention-sweep';
    ts: string;
} & SweepReport) | {
    kind: 'retention-failure';
    ts: string;
    trigger: RetentionTrigger;
    classId: RetentionClassId;
    count: number;
    code: string;
} | {
    kind: 'offered';
    ts: string;
    taskId: string;
    runtime?: string;
}
/** `admission`: how long this device took to admit the offer (#1014), as the claim carried it. */
 | {
    kind: 'claimed';
    ts: string;
    taskId: string;
    claimedRuntime?: string;
    admission?: OfferAdmissionTimings;
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
}
/** An `all` task reported a high-risk tool call; it was not blocked. `auto` asks through `awaiting-approval` instead. */
 | ({
    kind: 'tool-reminder';
    ts: string;
} & ToolReminder)
/** Local auto-gate decision; never a server protocol envelope. */
 | ({
    kind: 'tool-authorization';
    ts: string;
} & ToolAuthorizationDecision)
/**
 * #1061 slice 2 local file-scope audit (D12): one record per denial and one
 * per Attempt adopting a configured scope. Allow is never recorded. The
 * shape carries closed codes and a digest only — no raw or canonical path,
 * command, file content or rule body.
 */
 | {
    kind: 'file-scope';
    ts: string;
    taskId: string;
    decision: 'deny' | 'policy-adoption';
    lane: 'rpc' | 'prepared' | 'durable';
    homeAccess: 'writer' | 'memory-reader';
    scope: {
        source: 'host';
        mode: 'home' | 'workspaces';
        digest: string;
    };
    /** Adoption only: every root id the grant covers, home first. */
    rootIds?: readonly string[];
    /** Denial only: the root that failed, when one was identified. */
    rootId?: string;
    /** Denial only: the requested access, when one was identified. */
    access?: ToolFileAccess;
    /** Denial only: the typed failure code. */
    code?: 'file_scope_denied' | 'file_scope_unavailable' | 'file_scope_unsupported';
    /** Denial only: the typed failure reason. */
    reason?: string;
    /** Denial only: the native tool name. */
    toolName?: string;
    /** Denial only: the runtime's call id, when it supplied one. */
    toolCallId?: string;
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
    admission?: OfferAdmissionTimings;
} | {
    kind: 'cancelled';
    ts: string;
    taskId: string;
    reason?: string;
}
/** Issues #391/#394: every `Daemon.status().lifecycle` change, as it happens. */
 | {
    kind: 'lifecycle';
    ts: string;
    lifecycle: DaemonLifecycle;
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
    runtimes: RuntimeObservation[];
} | {
    kind: 'environment-resolved';
    ts: string;
    status: ServiceEnvironmentStatus;
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
 * A wire `task.approve`/`task.reject`, or a local `Daemon.approve`/
 * `reject`, named an approval that is not the one pending for its task:
 * a faster path (a racing local `approvals.resolve`, a timeout) already
 * resolved it, the same decision arrived twice, or it targets another
 * approval. `TaskRunner.handleApprove`/`handleReject` emit this and change
 * nothing. Audit-only: never gates any teardown/task-state decision.
 */
 | {
    kind: 'stale-approval-decision';
    ts: string;
    taskId: string;
    decision: 'approve' | 'reject';
    reason?: string;
} | {
    kind: 'runtime-disposal-failed';
    ts: string;
    taskId: string;
    runtimeId: string;
    stage: 'signal' | 'quiescence' | 'cleanup';
    reason: string;
}
/**
 * Octop ③ (#553): whether the SDK saw one started execution's whole event
 * trajectory — counts and closed codes only (`execution-record.ts`).
 * Emitted once, after that task's terminal event (`completed`, `failed`,
 * `cancelled` or a terminal `outbound-rejected`), unless the task registry
 * evicted the task first (`MAX_TRACKED_TASKS`). A record whose terminal
 * never settles in this process is not emitted. A diagnostic only: no task
 * state depends on it.
 */
 | ({
    kind: 'execution-record';
    ts: string;
} & ExecutionRecord)
/**
 * WP2I-S2: the Host's durable readback for a Host-approved Agent memory
 * intent contradicted the device's durable terminal (`disposition`
 * `conflict`, or `host_terminal` against a local terminal). The integrity
 * audit is already in the Agent home's memory audit tail and the notice was
 * acknowledged after the `ackedAt` barrier. Metadata only: the intent id and
 * the Host disposition — never a path, revision, outcome or Host text.
 */
 | {
    kind: 'agent-memory-intent-integrity';
    ts: string;
    intentId: string;
    disposition: 'conflict' | 'host_terminal';
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
 * never can be. That is structural, not a redaction rule: `daemon/audit-log.ts`
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
    delivery?: 'rejected';
    updatedAt: string;
}
/**
 * M3-B parity (see `task-runner/state.ts`'s `MAX_TRACKED_TASK_IDS` doc comment,
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
    private readonly approvalIdByEnvelope;
    private readonly pendingApprovalIdByTask;
    /**
     * Octop ③ (#553): execution records published before the server settled
     * their task's terminal, held so that the `execution-record` event follows
     * the terminal event. Only a task `taskInfo` tracks as nonterminal has an
     * entry, so `MAX_TRACKED_TASKS` bounds it too; see `evictIfNeeded`.
     */
    private readonly heldExecutionRecords;
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
    captureOutboundApproval(envelope: Envelope): void;
    /**
     * A sealed payload reaches here only when its plaintext was not kept
     * (`SealedTasks.plainOf`); it has no local view.
     */
    handleOutboundEnvelope(envelope: Envelope): void;
    noteOutboundRejected(envelope: Envelope, rejection: OutboundRejection): void;
    noteLifecycle(lifecycle: DaemonLifecycle): void;
    notePaired(deviceId: string): void;
    noteUnpaired(): void;
    noteRuntimesDetected(runtimes: RuntimeObservation[]): void;
    noteEnvironmentResolved(status: ServiceEnvironmentStatus, ts?: string): void;
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
    noteToolReminder(reminder: ToolReminder): void;
    noteToolAuthorizationDecision(decision: ToolAuthorizationDecision): void;
    /** #1061 slice 2 local file-scope audit (D12); allow is never recorded. */
    noteFileScopeAudit(event: Omit<Extract<DaemonEvent, {
        kind: 'file-scope';
    }>, 'kind' | 'ts'>): void;
    noteStaleApprovalDecision(taskId: string, decision: 'approve' | 'reject', reason?: string): void;
    /** WP2I-S2: see the `agent-memory-intent-integrity` `DaemonEvent` variant's own doc comment. */
    noteAgentMemoryIntentIntegrity(event: {
        intentId: string;
        disposition: 'conflict' | 'host_terminal';
    }): void;
    noteRuntimeDisposalFailure(event: {
        taskId: string;
        runtimeId: string;
        stage: 'signal' | 'quiescence' | 'cleanup';
        reason: string;
    }): void;
    /**
     * Octop ③ (#553): `TaskRunner` publishes a record after `Session.close()`,
     * which can finish before the server settles the terminal. Such a record
     * waits until its task's terminal event goes out. A task this registry no
     * longer tracks gets its record at once.
     */
    noteExecutionRecord(record: ExecutionRecord): void;
    private releaseExecutionRecord;
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
    noteRetentionSweep(report: SweepReport): void;
    noteRetentionFailure(trigger: RetentionTrigger, classId: RetentionClassId, code: string): void;
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
// ==== @byok-sdk/client dist/daemon/outbound-settlement.d.ts ====
import type { OutboundRefusalReason } from '@byok-sdk/protocol';
export interface OutboundRejection {
    readonly envelopeId: string;
    readonly type: string;
    readonly taskId?: string;
    readonly reason: OutboundRefusalReason;
    readonly terminal: boolean;
}
/** Counts for this daemon run; payload bytes are never part of this projection. */
export interface OutboundStatus {
    accepted: number;
    duplicate: number;
    rejected: number;
    rejectedByReason: Partial<Record<OutboundRefusalReason, number>>;
    rejectedTerminals: number;
    /** `task.progress` / `agent.message.draft` envelopes dropped unsent because the outbox passed its byte cap. */
    droppedEphemeral: number;
    lastRejection?: OutboundRejection;
}
// ==== @byok-sdk/client dist/daemon/progress-batcher.d.ts ====
import type { ActivityIngress, AgentEvent } from '@byok-sdk/protocol';
export type ProgressEmitter = (seq: number, events: AgentEvent[]) => void;
export interface ProgressBatcherOptions {
    /** Flush immediately once this many events are buffered. Default 10. */
    maxBatchSize?: number;
    /** Otherwise flush at most this often (ms) while events are pending. Default 250 (~4/sec). */
    flushIntervalMs?: number;
}
export declare class ProgressEventTooLargeError extends Error {
    readonly actualBytes: number;
    readonly maxBytes: number;
    constructor(actualBytes: number, maxBytes: number);
}
export declare function validateProgressBatcherOptions(options?: ProgressBatcherOptions): void;
/**
 * Coalesces a task's `AgentEvent`s into seq-ordered `task.progress` batches:
 * flush immediately at `maxBatchSize` events, otherwise at most every
 * `flushIntervalMs` while anything is buffered. One instance per task —
 * `seq` is a per-task monotonic counter starting at 1. `ingress` reads the
 * server-advertised activity limits at each push; there is no default.
 */
export declare class ProgressBatcher {
    private readonly emit;
    private readonly ingress;
    private buffer;
    private seq;
    private timer;
    private readonly maxBatchSize;
    private readonly flushIntervalMs;
    private bufferBytes;
    constructor(emit: ProgressEmitter, options: ProgressBatcherOptions | undefined, ingress: () => Readonly<ActivityIngress>);
    push(event: AgentEvent): void;
    /** M4 Phase 4 (part B.3, observability): events buffered right now, not yet flushed as a `task.progress` batch — a cheap per-task queue-depth watermark for the daemon's control-socket `status` result (see `task-runner.ts`'s `getQueueWatermarks`). */
    get pendingCount(): number;
    flush(): void;
    /** Stop the pending flush timer without flushing (used on teardown). */
    stop(): void;
    private ensureTimer;
    private clearTimer;
}
// ==== @byok-sdk/client dist/daemon/provider-provisioning.d.ts ====
import { type ProviderProvisioningAvailablePayload, type ProviderProvisioningReadback } from '@byok-sdk/protocol';
/** Exactly what the daemon hands the Host for one `provider.provisioning.available` notice. */
export interface ProviderProvisioningNotice {
    readonly requestId: string;
}
/**
 * Host-injected consumer of `provider.provisioning.available`.
 *
 * The SDK never sees the sealed request: the Host fetches it over its own
 * device-authenticated route, opens and applies it locally, reports the
 * credential-free completion, and resolves with the Host's DURABLE terminal
 * readback for that request. Only then does the daemon acknowledge the notice.
 *
 * A deterministic end state — applied, rejected, expired, sealing key rotated,
 * or a conflicting stored result — MUST be returned as a readback, never
 * thrown: a thrown error keeps the mailbox row and the cursor behind it, which
 * is correct only for transport or otherwise unknown failures that a
 * redelivery can still change.
 */
export type ProviderProvisioningHandler = (notice: ProviderProvisioningNotice) => Promise<ProviderProvisioningReadback>;
/**
 * Closed reasons a provisioning notice is left un-acknowledged. Nothing else
 * about the failure crosses the processor boundary.
 */
export declare const PROVIDER_PROVISIONING_NOTICE_FAILURE_REASONS: readonly ['handler_unconfigured', 'handler_failed', 'readback_invalid', 'readback_mismatch'];
export type ProviderProvisioningNoticeFailureReason = (typeof PROVIDER_PROVISIONING_NOTICE_FAILURE_REASONS)[number];
/**
 * The only error the provisioning processor throws.
 *
 * The Host handler runs next to credential bytes (sealed fetch, HPKE open, OS
 * credential store), so anything it throws or returns is untrusted for logging.
 * This error therefore carries a fixed message built from a closed reason and
 * the non-secret request id, NO `cause`, and no own enumerable properties: the
 * original error, its message, nested causes, attached fields and any schema
 * issues are dropped here and never reach the connection manager's log line.
 */
export declare class ProviderProvisioningNoticeError extends Error {
    #private;
    constructor(reason: ProviderProvisioningNoticeFailureReason, requestId: string);
    get reason(): ProviderProvisioningNoticeFailureReason;
    get requestId(): string;
}
export interface ProviderProvisioningNoticeProcessorOptions {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly handler: ProviderProvisioningHandler | undefined;
}
/**
 * Turn one notice into one exact, durable, terminal readback — or throw.
 *
 * Throwing is the only way this leaves a mailbox row un-acknowledged, and it
 * does so only with a {@link ProviderProvisioningNoticeError} naming one closed
 * reason: no handler is configured (a sender cannot turn a missing consumer
 * into a successful no-op), the handler threw, or what it returned is not a
 * valid terminal readback for THIS tenant, device and request.
 */
export declare function createProviderProvisioningNoticeProcessor(options: ProviderProvisioningNoticeProcessorOptions): (payload: ProviderProvisioningAvailablePayload) => Promise<ProviderProvisioningReadback>;
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
// ==== @byok-sdk/client dist/daemon/retention/config.d.ts ====
import { type ExpiringClassId } from './registry';
export declare class LocalStorageConfigError extends Error {
    constructor(field: string, reason?: string);
}
export interface StorageBudgetInput {
    maxStoreBytes: number;
    minFreeBytes: number;
    softMinFreeBytes?: number;
    softBudgetRatio?: number;
    hardBudgetRatio?: number;
    ackCriticalReserveBytes?: number;
}
export interface StorageConfig {
    scratchRoot?: string;
    budget?: StorageBudgetInput;
    /** Exact SDK skill-pack dataDir roots used by installSkillPacks. */
    skillPackDataDirs?: readonly string[];
    retention?: {
        sweepIntervalMs?: number;
        pressureSweepIntervalMs?: number;
        maxDeletionsPerPass?: number;
        maxPassDurationMs?: number;
        ttlMs?: Partial<Record<ExpiringClassId, number>>;
    };
    /** Every daemon journals tasks durably in `<storeDir>/daemon.db` before it acks them. */
    journal?: {
        /** Bound on waiting for the journal's write lock, ms. Defaults to the journal's own bound. */
        busyTimeoutMs?: number;
        /**
         * Per-record byte bound. Defaults to the journal's own bound (256 KiB); oversized records are refused, never truncated.
         * An inbound envelope record may still reach a floor derived from the inline sealed maximum (415083 bytes),
         * so a sealed envelope is journaled and declined, not stalled (#654). An inbound envelope above the bound is
         * not stored and does not stall the cursor: an offer is declined (`inbound_envelope_too_large`), any other
         * envelope is dropped (#826).
         */
        maxRecordBytes?: number;
    };
}
export interface StorageBudget {
    readonly maxStoreBytes: number;
    readonly minFreeBytes: number;
    readonly softMinFreeBytes: number;
    readonly softBudgetRatio: number;
    readonly hardBudgetRatio: number;
    readonly ackCriticalReserveBytes: number;
}
export declare const DEFAULT_RETENTION_TTL_MS: Readonly<Record<ExpiringClassId, number>>;
export declare function resolveStorageBudget(input: StorageBudgetInput): StorageBudget;
export declare function resolveStorageConfig(storeDir: string, input?: StorageConfig): Readonly<{
    scratchRoot: string;
    budget: StorageBudget | undefined;
    skillPackDataDirs: readonly string[];
    sweepIntervalMs: number;
    pressureSweepIntervalMs: number;
    maxDeletionsPerPass: number;
    maxPassDurationMs: number;
    ttlMs: Readonly<{
        "agent-result": number;
        "confirmed-journal": number;
        "daemon-temp": number;
        "durable-replica": number;
        "exec-runtime": number;
        "exec-sdk": number;
        "home-temp": number;
        "input-preparation": number;
        "pi-session-dir": number;
        "reader-run": number;
        "session-ledger": number;
        "skill-pack-old": number;
        "terminal-evidence": number;
    }>;
}>;
export type ResolvedStorageConfig = ReturnType<typeof resolveStorageConfig>;
// ==== @byok-sdk/client dist/daemon/retention/pressure.d.ts ====
import type { StorageBudget } from './config';
export type StoragePressureState = 'normal' | 'pressure' | 'hard-pressure' | 'emergency';
export declare class LocalStorageEmergencyError extends Error {
    constructor(reason: string);
}
export declare function computePressureState(budget: StorageBudget, usedBytes: number, freeBytes: number, latchedFailure?: string): StoragePressureState;
export declare class StoragePressure {
    readonly budget?: StorageBudget | undefined;
    state: StoragePressureState;
    private failure?;
    constructor(budget?: StorageBudget | undefined);
    update(usedBytes: number, freeBytes: number): void;
    noteAckCriticalFailure(reason: string): void;
    admissionGuard(): {
        admit: true;
        reason?: undefined;
        retryable?: undefined;
    } | {
        admit: false;
        reason: string;
        retryable: boolean;
    };
    assertAckCriticalAllowed(): void;
}
// ==== @byok-sdk/client dist/daemon/retention/registry.d.ts ====
export declare const EXPIRING_CLASS_IDS: readonly ['exec-sdk', 'daemon-temp', 'exec-runtime', 'durable-replica', 'input-preparation', 'confirmed-journal', 'reader-run', 'agent-result', 'home-temp', 'skill-pack-old', 'session-ledger', 'terminal-evidence', 'pi-session-dir'];
export declare const PROTECTED_CLASS_IDS: readonly ['journal', 'quarantine', 'owned-processes', 'durable-replica-live', 'agent-content', 'byok-authority', 'agent-home-lease', 'skill-pack-current', 'store-authority', 'runtime-session-external'];
export type ExpiringClassId = typeof EXPIRING_CLASS_IDS[number];
export type ProtectedClassId = typeof PROTECTED_CLASS_IDS[number];
export type RetentionClassId = ExpiringClassId | ProtectedClassId;
export type RetentionTrigger = 'startup' | 'periodic' | 'pressure' | 'home-lease';
export interface ClassUsage {
    readonly classId: RetentionClassId;
    readonly protected: boolean;
    readonly measured: boolean;
    /** The usage walk hit its entry limit before covering this class: `bytes` and `entries` are lower bounds. */
    readonly truncated: boolean;
    readonly bytes: number;
    readonly entries: number;
    readonly oldestAgeMs: number | null;
}
export interface SweepReport {
    readonly trigger: RetentionTrigger;
    readonly at: string;
    readonly deleted: number;
    readonly bytesReclaimed: number;
    readonly failures: number;
    readonly truncated: boolean;
    readonly durationMs: number;
}
export interface SweepBudget {
    readonly now: Date;
    readonly trigger: RetentionTrigger;
    available(): boolean;
    remaining(): number;
    removed(bytes: number): void;
    truncate(): void;
}
/**
 * How a class stays finite. An expiring class is deleted by TTL, optionally also by count. A protected
 * class either has a fixed count, or states why it cannot be bounded, who clears it and through which API.
 */
export type RetentionBound = {
    readonly kind: 'ttl';
    readonly ttlMs: number;
    readonly maxEntries?: number;
} | {
    readonly kind: 'count';
    readonly maxEntries: number;
    readonly per: 'agent-home' | 'skill-pack';
} | {
    readonly kind: 'exempt';
    readonly reason: string;
    readonly cleanedBy: 'sdk' | 'host' | 'operator';
    readonly api: string;
};
export type ProtectedRetentionBound = Exclude<RetentionBound, {
    readonly kind: 'ttl';
}>;
/** The declared bound of every protected class; a new class does not compile without one. */
export declare const PROTECTED_CLASS_BOUNDS: Readonly<Record<ProtectedClassId, ProtectedRetentionBound>>;
export interface ClassAuthority {
    readonly roots: readonly string[];
    readonly owner: 'sdk' | 'host';
    readonly scope: 'store' | 'agent-home' | 'replica' | 'host';
    readonly bound: RetentionBound;
}
export type RetentionClass = {
    readonly authority: ClassAuthority;
} & ({
    readonly id: ExpiringClassId;
    measure(): Promise<ClassUsage>;
    sweep(budget: SweepBudget): Promise<void>;
} | {
    readonly id: ProtectedClassId;
    measure(): Promise<ClassUsage>;
    readonly sweep?: never;
});
/** One closed registry serves maintenance, pressure measurement and status. */
export declare class RetentionRegistry {
    private readonly dispose;
    private readonly beforeMeasure;
    private readonly prepareMaintenance;
    readonly classes: readonly RetentionClass[];
    constructor(classes: readonly RetentionClass[], dispose?: () => Promise<void>, beforeMeasure?: () => void, prepareMaintenance?: (budget: SweepBudget, underPressure: boolean) => Promise<void>);
    prepare(budget: SweepBudget, underPressure: boolean): Promise<void>;
    close(): Promise<void>;
    sweep(id: ExpiringClassId, budget: SweepBudget): Promise<void>;
    measure(): Promise<ClassUsage[]>;
}
// ==== @byok-sdk/client dist/daemon/retention/scratch.d.ts ====
export declare class ScratchRootPathError extends Error {
    constructor(reason: string);
}
/** Resources owned by one execution. release() is part of its disposal receipt. */
export interface ExecutionScratch {
    readonly token: string;
    readonly sdkDir: string;
    readonly runtimeDir: string;
    readonly env: Readonly<{
        TMPDIR: string;
        TEMP: string;
        TMP: string;
    }>;
    release(): Promise<void>;
}
/**
 * The runtime Unix socket budget of a scratch root (#493): its byte length
 * and, where the platform bounds `sun_path`, the longest root that still fits.
 */
export declare function scratchRootSocketBudget(root: string, platform?: NodeJS.Platform): {
    readonly bytes: number;
    readonly maximumBytes?: number;
};
export declare function validateScratchRoot(root: string, platform?: NodeJS.Platform): string;
/**
 * The root used when the Host configures none. `<storeDir>/tmp` keeps scratch
 * beside the store it serves. An application-data storeDir is often too long
 * for runtime sockets, so that case moves to a fixed short root keyed by a
 * canonical storeDir hash, as `storeMutexEndpoint` does. Not `os.tmpdir()`: it varies
 * with the environment, and on macOS it resolves through a symlink to a path
 * past the budget. The macOS literal is `/private/tmp` because `/tmp` is a
 * symlink there and {@link privateDirectory} rejects symbolic-link ancestors.
 */
export declare function defaultScratchRoot(storeDir: string, platform?: NodeJS.Platform): string;
/**
 * The #493 placement rule, without filesystem access: the fixed short root
 * for a store whose `<store>/tmp` exceeds the runtime socket budget, or
 * `undefined` when `<store>/tmp` fits or the platform has no limit.
 * {@link defaultScratchRoot} passes the canonical store; `resolveHostLayout`
 * passes the lexical recommended store.
 */
export declare function shortScratchRoot(store: string, platform: NodeJS.Platform): string | undefined;
/**
 * Reject aliases before changing permissions or deleting anything. With
 * `ownedLeaf`, a leaf another user created first (a root in a shared directory
 * such as /tmp) is refused before any permission change.
 */
export declare function privateDirectory(directory: string, options?: {
    ownedLeaf?: boolean;
}): Promise<void>;
export declare class ScratchRoot {
    readonly root: string;
    private readonly live;
    private store?;
    readonly clock: () => Date;
    constructor(root: string, clock?: () => Date);
    isLive(token: string): boolean;
    open(storeDir: string): Promise<void>;
    private claim;
    abandon(token: string): void;
    create(): Promise<ExecutionScratch>;
}
/** Standalone adapter Hosts own this root exclusively and await release(). */
export declare function createExecutionScratch(options: {
    root: string;
    clock?: () => Date;
}): Promise<ExecutionScratch>;
export declare function createDaemonScratch(storeDir: string, kind: 'diag' | 'credential' | 'prepare'): Promise<string>;
// ==== @byok-sdk/client dist/daemon/retention/sweeper.d.ts ====
import type { ResolvedStorageConfig } from './config';
import { type ClassUsage, type RetentionClassId, type RetentionTrigger, type SweepReport, RetentionRegistry } from './registry';
import { StoragePressure } from './pressure';
export interface RetentionTimers {
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
export interface RetentionSnapshot {
    readonly measuredAt: string | null;
    readonly usedBytes: number;
    readonly freeBytes: number | null;
    readonly classes: readonly ClassUsage[];
    readonly lastSweep: SweepReport | null;
}
export declare function unmeasuredRetentionSnapshot(): RetentionSnapshot;
export interface RetentionSweeperOptions {
    readonly config: ResolvedStorageConfig;
    readonly registry: RetentionRegistry;
    readonly pressure: StoragePressure;
    readonly freeBytes: () => Promise<number>;
    readonly clock?: () => Date;
    readonly timers?: RetentionTimers;
    readonly jitter: (sequence: number, baseMs: number) => number;
    readonly onSweep?: (report: SweepReport) => void;
    readonly onFailure?: (trigger: RetentionTrigger, classId: RetentionClassId, code: string) => void;
}
/** All maintenance has this one lifecycle owner, including daemons without a journal. */
export declare class RetentionSweeper {
    private readonly options;
    private timer;
    private running?;
    private stopped;
    private sequence;
    private readonly clock;
    private readonly timers;
    private status;
    constructor(options: RetentionSweeperOptions);
    snapshot(): RetentionSnapshot;
    runPass(trigger: RetentionTrigger): Promise<SweepReport>;
    private pass;
    start(): void;
    private arm;
    stop(): Promise<void>;
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
export declare function readInstalledSkillPack(dataDir: string, name: string): Promise<InstalledSkillPack | undefined>;
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
import { type DeviceCredentialBackend, type DeviceCredentialConfig, type DeviceMetadata, type DeviceRecord } from './device-credential-store';
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
    deviceCredentials?: DeviceCredentialConfig;
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
 * Device-proof key id of the one key a local enrollment holds: the Ed25519
 * identity key registered at pairing. The pairing contract registers that key
 * as proof key `identity` at epoch `0` (`@byok-sdk/cloud`
 * `DEVICE_IDENTITY_PROOF_KEY_ID` / `DEVICE_IDENTITY_PROOF_KEY_EPOCH`, stored as
 * the device row's `proof_key_id` / `proof_key_epoch`); the pairing response
 * carries neither value, so this is the local projection of that contract,
 * held equal to cloud by a drift test. A future proof-key rotation must carry
 * the epoch through its own authenticated response into the local record and
 * replace this projection in the same cut.
 */
export declare const DEVICE_ENROLLMENT_PROOF_KEY_ID = "identity";
/** Epoch of {@link DEVICE_ENROLLMENT_PROOF_KEY_ID}; see its documentation. */
export declare const DEVICE_ENROLLMENT_PROOF_KEY_EPOCH = 0;
/**
 * Non-secret identity of the current authenticated enrollment: everything a
 * host needs to address this device and to build device proofs or sealed
 * provisioning identity snapshots, and nothing that authenticates it.
 */
export interface DeviceEnrollmentIdentity {
    /** Authenticated tenant binding written only by pairing. */
    readonly tenantId: string;
    readonly deviceId: string;
    /** Device-proof `keyId` the enrollment key is registered under. */
    readonly proofKeyId: string;
    /** Device-proof `keyEpoch` the enrollment key is registered under. */
    readonly proofKeyEpoch: number;
    /**
     * Sealed provisioning `enrollmentRevision`: the decimal string of
     * `proofKeyEpoch`. A Host issues the same value from its device row
     * (`String(proof_key_epoch)`) as `expectedEnrollmentRevision`. It is
     * monotonic across proof-key rotation for one device id; re-pair mints a new
     * device id, so `(tenantId, deviceId, enrollmentRevision)` names exactly one
     * enrollment key.
     */
    readonly enrollmentRevision: string;
}
/** Cold read of the enrollment identity; the non-paired states match {@link DeviceEnrollmentStatus}. */
export type DeviceEnrollmentIdentityStatus = {
    readonly state: 'unpaired';
} | {
    readonly state: 're_pair_required';
} | ({
    readonly state: 'paired';
} & DeviceEnrollmentIdentity);
/**
 * Package-internal read of the complete enrollment authority. It is the one
 * classification shared by the public status/identity reads and the host
 * device-proof signer, and it never writes (no metadata reconcile).
 */
export type EnrollmentAuthorityRead = {
    readonly state: 'unpaired';
} | {
    readonly state: 're_pair_required';
} | {
    readonly state: 'paired';
    readonly record: DeviceRecord;
};
/**
 * A durable enrollment record cannot be used by any steady-state path. Only
 * the explicit pair operation may replace it with a fresh authenticated row.
 */
export declare class DeviceRecordRePairRequiredError extends Error {
    constructor();
}
/**
 * The one binding check between a storeDir and the shared OS enrollment: the
 * `device.json` that pairing wrote must name exactly the stored enrollment.
 */
export declare function assertStoreBound(projection: DeviceMetadata | undefined, authority: DeviceMetadata): void;
/**
 * Persists only bounded non-secret enrollment projection. The paired bearer
 * token and private key are never accepted here and are owned by the internal
 * OS DeviceCredentialStore.
 */
export declare class DeviceStore {
    readonly credentials: DeviceCredentialBackend;
    private readonly secureDirOptions?;
    private readonly filePath;
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
    constructor(storeDir: string, credentials: DeviceCredentialBackend, secureDirOptions?: EnsureSecureDirOptions | undefined);
    /**
     * Resolve the one store pathname every daemon/CLI component must share.
     * A configured relative path is anchored once at process entry rather than
     * being reinterpreted after a diagnostics operation temporarily changes
     * cwd to pin a quarantine directory inode. Name aliases (8.3 short names,
     * letter case) are folded into the on-disk spelling here, so the daemon and
     * every CLI derive the same control endpoint, Agent-home owner and retention
     * roots from one spelling.
     */
    static resolveDir(productId: string, configured?: string): string;
    load(): Promise<DeviceMetadata | undefined>;
    /**
     * Read and remove the exact bounded, no-follow device record under the
     * caller's mutation lease. The hard-link guard keeps the inspected inode
     * identifiable until the synchronous pathname check and unlink complete.
     */
    remove(): Promise<DeviceMetadata | undefined>;
    /**
     * Rebuild only the non-secret projection, while the caller owns the store
     * lease. Only the operator-confirmed doctor `restore-enrollment-metadata`
     * action calls this; startup and reads never adopt an enrollment.
     */
    reconcileMetadata(authority: DeviceMetadata): Promise<boolean>;
    save(record: DeviceMetadata): Promise<void>;
    private openBounded;
}
/**
 * Read and classify the canonical device store without writing anything.
 * A legacy/tampered record remains distinct from an absent record so hosts can
 * require explicit re-pair instead of silently changing semantics. Filesystem,
 * pathname-safety and credential-provider failures intentionally remain errors,
 * and so does an OS enrollment this storeDir did not pair
 * ({@link DeviceStoreBindingMismatchError}).
 */
export declare function readEnrollmentAuthority(options: DeviceEnrollmentStatusOptions): Promise<EnrollmentAuthorityRead>;
/** The public non-secret identity projection of one enrollment record. */
export declare function enrollmentIdentityOf(record: DeviceMetadata): DeviceEnrollmentIdentity;
/**
 * Read the canonical device store without projecting credential or tenant
 * material. See {@link readEnrollmentAuthority} for the state classification.
 */
export declare function readDeviceEnrollmentStatus(options: DeviceEnrollmentStatusOptions): Promise<DeviceEnrollmentStatus>;
/**
 * Read the non-secret identity of the current enrollment: tenant, device and
 * the device-proof key id/epoch, plus the derived sealed-provisioning
 * `enrollmentRevision`. Never returns the access token, private key or public
 * key, never writes, and uses the same classification as
 * {@link readDeviceEnrollmentStatus}. It reads the calling process's OS
 * credential set, so it observes the enrollment of the account the daemon runs
 * as only when called as that account.
 */
export declare function readDeviceEnrollmentIdentity(options: DeviceEnrollmentStatusOptions): Promise<DeviceEnrollmentIdentityStatus>;
// ==== @byok-sdk/client dist/daemon/task-runner/state.d.ts ====
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
 * M3-B: cap for both `finishedTaskIds` and `pendingCancelled` below (each
 * gains one entry per finished/cancelled task and was never pruned) — fine
 * for the short-lived CLI invocations M0-M2 ran as, but M3 turns the daemon
 * into a background service meant to stay up for weeks, so unbounded growth
 * here is a real, if slow, memory leak. Each collection evicts its OLDEST
 * (first-inserted) entry once over this cap — the bounded-ring idiom the old
 * reference server's per-device dedup window used, applied here to task ids
 * (server-side dedup is now the cloud kernel's dedup store). `Map`/`Set` iterate in insertion order (ECMA-262), so "oldest"
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
export declare const ACTIVITY_INGRESS_EXCEEDED_REASON_PREFIX = "resource limit exceeded: activity ingress budget";
/**
 * Wire v3 result channel: the stable reason PREFIX of the `task.fail` a
 * `terminalProjection.mode: 'result-document'` task gets when its runtime
 * ended the turn without a staged `submit_result` outcome. Same
 * stable-prefix contract as {@link MAX_DURATION_EXCEEDED_REASON_PREFIX};
 * `retryable: false`, because the same offer on the same runtime has no
 * reason to submit on a second attempt. The SDK never derives the outcome
 * from the runtime's text.
 */
export declare const RESULT_NOT_SUBMITTED_REASON_PREFIX = "result_not_submitted";
/**
 * Stable reason PREFIX of the `task.fail` a result-document task gets when
 * its staged outcome cannot be read back at `turn_end` (an unreadable or
 * mismatched record in the Agent home). `retryable: false`; the record is
 * preserved for repair.
 */
export declare const RESULT_UNREADABLE_REASON_PREFIX = "result_unreadable";
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
/** Internal task lifecycle phase. Not the wire TaskState (protocol/task-state.ts). */
export type TaskPhase = 'received' | 'admitting' | 'claiming' | 'claimed' | 'running' | 'awaiting_approval' | 'terminalizing' | 'retiring' | 'finished' | 'declined';
/** Ordered effect classes (§6.1): atomic groups cannot be interleaved. */
export type EffectMode = 'atomic' | 'barrier' | 'bestEffort';
export type TerminalKind = 'complete' | 'failed' | 'cancelled' | 'declined';
export type TerminalCause = 'complete' | 'failed' | 'cancelled' | 'declined' | 'rejected' | 'shutdown';
export type TerminalStage = 'selected' | 'evidence' | 'envelope' | 'sent' | 'closed' | 'committed';
export type ApprovalKind = 'tool-authorization' | 'task-terminal';
export type ApprovalDecision = 'approve' | 'reject';
export type ApprovalOrigin = 'wire' | 'in-process' | 'control-socket' | 'timeout' | 'withdraw' | 'eviction' | 'fail-closed';
/** Every effect the host executor knows, in one vocabulary (§6.2). */
export type EffectKind = 'open.sealed' | 'journal.admission' | 'open.preparation' | 'reserve.home' | 'admission.limits' | 'prepare.runtime' | 'bind.workspace' | 'seal.manifest' | 'pin.preparation' | 'clear.sealedOpening' | 'track.inflight' | 'consume.pendingCancelled' | 'send.decline' | 'send.claim' | 'send.terminal' | 'send.started' | 'send.cancelled' | 'send.fail' | 'send.approval_request' | 'send.approval_resolved' | 'flush.batcher' | 'stop.batcher' | 'stop.draft' | 'mark.finished' | 'abort.blob' | 'abort.inflightBlob' | 'abort.inflightBlobs' | 'revoke.contexts' | 'revoke.host_contexts' | 'revoke.allHostContexts' | 'revoke.message_context' | 'delete.contexts' | 'delete.host_contexts' | 'register.startup_owner' | 'dispose.startup' | 'dispose.startup_all' | 'transfer.startup' | 'startup.stopRetry' | 'start.runtime' | 'bind.session' | 'persist.handoff' | 'activate.message' | 'register.active' | 'arm.max_duration' | 'start.pump' | 'register.approval' | 'arm.approval_timeout' | 'clear.timeout' | 'resolve.approval' | 'resolve.approval_promise' | 'dispatch.next_approval' | 'drain.approval_queue' | 'persist.evidence' | 'prepare.envelope' | 'interrupt.session' | 'await.close' | 'await.terminal_commit' | 'retry.close' | 'retry.commit' | 'publish.record' | 'snapshot.memory' | 'release.lease' | 'release.pin' | 'release.scratch' | 'release.home_reservation' | 'release.deviceSlot' | 'finish' | 'finish.declined' | 'failClaimedAgent' | 'steer.session' | 'await.offerSettlements' | 'shutdown.fail_active_tasks' | 'report.disposalFailure' | 'log' | 'audit';
/** Pure effect description; never a handle or a closure. */
export interface Effect {
    readonly kind: EffectKind;
    readonly taskId?: string;
    readonly reason?: string;
    readonly retryable?: boolean;
    readonly token?: string;
    readonly requestId?: string;
    readonly approvalId?: string;
    readonly decision?: ApprovalDecision;
    readonly approved?: boolean;
    readonly origin?: ApprovalOrigin;
    readonly stage?: string;
    readonly detail?: Readonly<Record<string, string | number | boolean>>;
}
/** Pre-execution predicate (§6.1). */
export interface EffectRequires {
    readonly phase?: readonly TaskPhase[];
    readonly claim?: 'required' | 'forbidden';
    readonly terminal?: 'none' | 'selected';
    readonly generation?: number;
    readonly alwaysRun?: boolean;
}
/** A completion event the host enqueues after a synchronous atomic effect. */
export type ReducerEventTemplate = Omit<ReducerEvent, 'type' | 'taskId' | 'atMs'> & {
    readonly type: ReducerEventType;
};
export interface EffectEnvelope {
    readonly id: string;
    readonly effect: Effect;
    readonly asOfRevision: number;
    readonly mode: EffectMode;
    readonly requires?: EffectRequires;
    /** Present only for atomic effects that produce their own completion synchronously. */
    readonly completion?: ReducerEventTemplate;
}
/** Intermediate effect produced by a transition row, before envelope ids. */
export interface EffectSpec {
    readonly effect: Effect;
    readonly mode: EffectMode;
    readonly requires?: EffectRequires;
    readonly completion?: ReducerEventTemplate;
}
export interface OfferMessageFactsV1 {
    readonly required: boolean;
    readonly contentType?: string;
    readonly maxBytes?: number;
}
export interface OfferTerminalProjectionV1 {
    readonly mode: string;
    readonly contract?: string;
}
export interface OfferPreparationV1 {
    readonly reference: string;
    readonly memoryMode: string;
}
/** Decision-relevant offer facts only; no instruction/schema/payload bytes. */
export interface OfferFactsV1 {
    readonly digest: string;
    readonly readerAttempt: boolean;
    readonly homeAccess: 'writer' | 'memory-reader';
    readonly egressEnabled: boolean;
    readonly requiredToolsets: readonly string[];
    readonly strict: boolean;
    readonly sealed: boolean;
    readonly requestedRuntime?: string;
    readonly dispatchRuntime?: string;
    readonly harnessId?: string;
    readonly agentRef?: string;
    readonly sessionRef?: string;
    readonly maxDurationMs?: number;
    readonly message?: OfferMessageFactsV1;
    readonly terminalProjection?: OfferTerminalProjectionV1;
    readonly preparation?: OfferPreparationV1;
}
export interface AdmissionDeclineV1 {
    readonly stage: string;
    readonly reason: string;
    readonly retryable: boolean;
    readonly code?: string;
}
export interface AdmissionStateV1 {
    readonly stage: string;
    readonly deviceSlot: boolean;
    readonly scratch: boolean;
    readonly lease: boolean;
    readonly homeReservation?: string;
    readonly pin?: string;
    readonly decline?: AdmissionDeclineV1;
}
export interface StartupStateV1 {
    readonly owner?: 'startup' | 'active';
    readonly registered: boolean;
    readonly dispose: 'none' | 'pending' | 'settled';
}
export interface ClaimStateV1 {
    readonly journaled: boolean;
    readonly sent: boolean;
}
export interface ExecutionFactsV1 {
    readonly sessionRef: string;
    readonly runtimeId: string;
    readonly harnessId?: string;
    readonly home: string;
    readonly cwd: string;
    readonly leaseId: string;
    readonly startedAtMs: number;
}
export interface PendingApprovalV1 {
    readonly approvalId: string;
    readonly requestId: string;
    readonly kind: ApprovalKind;
}
export interface ApprovalQueueEntryV1 {
    readonly requestId: string;
    readonly kind: ApprovalKind;
}
export interface ApprovalStateV1 {
    readonly pending?: PendingApprovalV1;
    readonly queue: readonly ApprovalQueueEntryV1[];
}
export interface MessageStateV1 {
    readonly accepted: boolean;
    readonly sendAttempted: boolean;
}
export interface CompletionStateV1 {
    readonly token: string;
    readonly kind: 'complete';
    readonly atMs: number;
}
export interface TerminalStateV1 {
    readonly token: string;
    readonly kind: TerminalKind;
    readonly cause: TerminalCause;
    readonly stage: TerminalStage;
    readonly evidence: 'none' | 'ok' | 'degraded';
    readonly envelope: 'none' | 'ready';
    readonly reason?: string;
    readonly retryable?: boolean;
    readonly failureClass?: string;
}
export interface CancelStateV1 {
    readonly requested: boolean;
    readonly reason?: string;
    readonly source?: 'wire' | 'in-process' | 'shutdown' | 'timeout' | 'local';
    readonly atMs?: number;
}
export interface TeardownStateV1 {
    readonly hostContexts: 'live' | 'revoked' | 'deleted';
    readonly batcher: 'stopped' | 'running';
    readonly blob: 'live' | 'aborted';
    readonly interrupt: 'none' | 'pending' | 'settled';
    readonly close: 'none' | 'pending' | 'settled' | 'failed';
    readonly commit: 'none' | 'pending' | 'ok' | 'failed';
    readonly lease: 'none' | 'held' | 'released';
    readonly pin: 'none' | 'held' | 'released';
    readonly scratch: 'none' | 'held' | 'released';
}
/** Per-task state: JSON-serializable, deep frozen, O(1) sized. */
export interface TaskStateV1 {
    readonly v: 1;
    readonly taskId: string;
    readonly generation: number;
    readonly revision: number;
    readonly phase: TaskPhase;
    readonly offer: OfferFactsV1;
    readonly admission: AdmissionStateV1;
    readonly startup: StartupStateV1;
    readonly claim: ClaimStateV1;
    readonly execution?: ExecutionFactsV1;
    readonly approval: ApprovalStateV1;
    readonly message: MessageStateV1;
    readonly completion?: CompletionStateV1;
    readonly terminal?: TerminalStateV1;
    readonly cancel: CancelStateV1;
    readonly teardown: TeardownStateV1;
}
export interface PendingCancelV1 {
    readonly taskId: string;
    readonly reason?: string;
    readonly atMs: number;
}
export interface ShutdownStateV1 {
    readonly reason: string;
    readonly atMs: number;
    readonly phase: 'stopping' | 'draining' | 'complete';
}
/** Runner-wide state: bounded collections and global gates. */
export interface RunnerStateV1 {
    readonly v: 1;
    readonly revision: number;
    readonly acceptingOffers: boolean;
    readonly shutdown?: ShutdownStateV1;
    readonly pendingCancelled: readonly PendingCancelV1[];
    readonly finished: readonly string[];
    readonly strictDeclined: readonly string[];
    readonly sealedOpening: readonly string[];
    readonly homeReservations: Readonly<Record<string, number>>;
}
export interface ReducerSnapshot {
    readonly runner: RunnerStateV1;
    readonly task?: TaskStateV1;
}
export type ReducerEventType = 'offer.sealed_opening' | 'offer.received' | 'offer.sealed_opened' | 'offer.sealed_declined' | 'admission.begin' | 'admission.stage' | 'admission.declined' | 'admission.claimable' | 'claim.journaled' | 'claim.journal_failed' | 'claim.sent' | 'startup.registered' | 'startup.transferred' | 'startup.disposed' | 'runtime.session_bound' | 'runtime.started' | 'runtime.activation_failed' | 'runtime.start_failed' | 'runtime.run_failed' | 'turn.ended' | 'stream.ended' | 'resource.exceeded' | 'approval.requested' | 'approval.dispatch_next' | 'approval.decided' | 'approval.withdrawn' | 'approval.stale' | 'terminal.requested' | 'terminal.evidence' | 'terminal.envelope_ready' | 'terminal.envelope_failed' | 'terminal.sent' | 'terminal.close' | 'terminal.commit' | 'finish.completed' | 'retry.finalization' | 'cancel.received' | 'steer.received' | 'steer.failed' | 'message.accepted' | 'message.refused' | 'message.send_attempted' | 'shutdown.stop_accepting' | 'shutdown.drain' | 'shutdown.completed';
/**
 * One internal event. Payloads are deliberately flat: a transition row names
 * exactly the fields it reads, and every field stays JSON-serializable. Ids and
 * timestamps are injected by the host; the reducer never mints them.
 */
export interface ReducerEvent {
    readonly type: ReducerEventType;
    readonly atMs: number;
    readonly taskId?: string;
    readonly generation?: number;
    readonly offer?: OfferFactsV1;
    readonly strict?: boolean;
    readonly sealed?: boolean;
    readonly stage?: string;
    readonly reason?: string;
    readonly retryable?: boolean;
    readonly code?: string;
    readonly kind?: TerminalKind | ApprovalKind;
    readonly decision?: ApprovalDecision;
    readonly origin?: ApprovalOrigin;
    readonly approvalId?: string;
    readonly requestId?: string;
    readonly token?: string;
    readonly ok?: boolean;
    readonly source?: 'wire' | 'in-process' | 'shutdown' | 'timeout' | 'local';
    readonly execution?: ExecutionFactsV1;
    readonly completionToken?: string;
}
export type Disposition = 'applied' | 'dropped' | 'rejected' | 'threw';
export interface RowOutcome {
    readonly runner: RunnerStateV1;
    readonly task?: TaskStateV1;
    readonly effects: readonly EffectSpec[];
    readonly disposition?: Disposition;
    readonly threw?: boolean;
}
export interface TransitionRow {
    readonly id: string;
    readonly events: readonly ReducerEventType[];
    /** Task phases this row accepts; `none` = task absent, `*` = any. */
    readonly phase: readonly TaskPhase[] | 'none' | '*';
    readonly when?: (snapshot: ReducerSnapshot, event: ReducerEvent) => boolean;
    readonly apply: (snapshot: ReducerSnapshot, event: ReducerEvent) => RowOutcome;
    /** Contract sentence: rejection / race semantics for this row. */
    readonly rejection: string;
    readonly disposition?: Disposition;
}
export interface ReduceResult {
    readonly runner: RunnerStateV1;
    readonly task?: TaskStateV1;
    readonly effects: readonly EffectEnvelope[];
    readonly disposition: Disposition;
    /** Stable transition row id, or a cross-cutting guard id. */
    readonly rowId: string;
    readonly reason?: string;
}
export declare function terminalTokenFor(taskId: string, revision: number): string;
export declare function createRunnerState(): RunnerStateV1;
export declare function createOfferFacts(overrides?: Partial<OfferFactsV1>): OfferFactsV1;
export interface CreateTaskStateInput {
    readonly taskId: string;
    readonly generation?: number;
    readonly revision?: number;
    readonly phase?: TaskPhase;
    readonly offer?: OfferFactsV1;
}
export declare function createTaskState(input: CreateTaskStateInput): TaskStateV1;
/** Canonical JSON for goldens/tests only — not a production API. */
export declare function serialize(value: unknown): string;
/** UTF-8 byte size of the canonical serialization. */
export declare function stateBytes(value: unknown): number;
/** The single data source for reducer behavior (§7). Order is priority. */
export declare const TRANSITIONS: readonly TransitionRow[];
/**
 * The table is frozen on first use, not at module evaluation: S1 keeps the
 * reducer out of the client entry bundle (the closure budget is exact), and a
 * top-level freeze call defeats tree shaking.
 */
export declare function transitionTable(): readonly TransitionRow[];
/**
 * Applies one event to a frozen runner/task snapshot and returns the next
 * frozen snapshot plus ordered effect descriptions. Pure: no clock, no ids,
 * no IO, no mutation of the input. Stale generation / wrong task / already
 * finished task ids drop before the table is consulted.
 */
export declare function reduce(snapshot: ReducerSnapshot, event: ReducerEvent): ReduceResult;
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
export interface ResetDeviceCursorInput {
    confirmed: true;
}
export interface DeviceCursorResetResult {
    action: 'reset-cursor';
    scope: 'device';
    /** The cursor file now holds 0; nothing was replayed yet. */
    status: 'reset';
}
declare const CURSOR_RESET_MESSAGES: {
    readonly 'confirmation-required': 'Explicit confirmation is required to reset the delivery cursor.';
    readonly 'daemon-running': 'Stop the daemon before resetting the delivery cursor.';
    readonly 'store-busy': 'The store is owned by another operation; cursor reset refused.';
    readonly unpaired: 'No readable device record exists; pair this device instead of resetting its cursor.';
    readonly 'reset-failed': 'The delivery cursor could not be reset; inspect the store before retrying.';
};
export type DeviceCursorResetErrorCode = keyof typeof CURSOR_RESET_MESSAGES;
/** Closed diagnostics only, like {@link DeviceMetadataRepairError}. */
export declare class DeviceCursorResetError extends Error {
    readonly code: DeviceCursorResetErrorCode;
    constructor(code: DeviceCursorResetErrorCode);
}
/**
 * #1121: the operator recovery for the `cursor_unreadable` halt. Rewrites the
 * paired device's delivery cursor as 0, so the next start asks the server to
 * replay everything it still retains for this device. Replay is safe: a
 * redelivered offer this device journaled is matched by its id, and the
 * server suppresses offers whose task already ended. If the server no longer
 * retains seq 1, the next start halts `replay_cursor_too_old` as for any
 * expired cursor. Refused while the daemon runs; takes the store's owner lease.
 */
export declare function resetDeviceCursor(config: DaemonConfig, input: ResetDeviceCursorInput): Promise<DeviceCursorResetResult>;
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
    readonly 'owned-process-residue': 'Runtime processes a crashed daemon left could not be ended. Start the daemon to see the record path, verify the processes are gone, then delete that record from the owned-processes directory of the device store.';
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
    /** Absolute, previously unused file in an existing directory outside the device store. */
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
// ==== @byok-sdk/client dist/diagnostics/store-compatibility.d.ts ====
import type { StoreCompatibility } from '@byok-sdk/core';
export interface InspectDaemonStoresInput {
    /** The daemon's resolved store directory (`DaemonConfig.storeDir` or its default). */
    readonly storeDir: string;
}
/**
 * Store compatibility precheck for the stores a daemon owns (#1102): the
 * local task journal (`<storeDir>/daemon.db`) and every pi-durable replica
 * under `<storeDir>/durable-replicas/`.
 *
 * Reports what this build does when it opens each one. The files are copied to
 * a private temporary directory and this build's own open runs on the copy, so
 * the format rules stay in the store code and the originals are only read.
 * Stop the daemon first: a file that changes while it is copied fails the
 * check rather than yielding a verdict about a torn copy.
 *
 * The journal comes first and is `absent` when there is none; one result
 * follows per replica. The server SQLite store and the provider profile store
 * are checked by `inspectSqliteStore` (`@byok-sdk/server`) and
 * `inspectProviderProfileStore` (`@byok-sdk/keys`).
 */
export declare function inspectDaemonStores(input: InspectDaemonStoresInput): Promise<readonly StoreCompatibility[]>;
// ==== @byok-sdk/client dist/diagnostics/types.d.ts ====
import type { RuntimeDetectResult, RuntimeDetectionRefusalReason, RuntimeExecutableSource, RuntimeVersionVerdict } from '../types';
import type { RuntimeVersionChange } from '../runtime-detection';
import type { ControlStatusResult } from '../daemon/control-protocol';
import type { OperationalHealthFileInspection } from '../daemon/operational-health';
import type { DaemonLifecycle } from '../daemon/daemon-lifecycle';
import type { ServiceEnvironmentRecord, ServiceEnvironmentUnavailableCode } from '../login-shell-environment';
export type DiagnosticStatus = 'pass' | 'warn' | 'fail';
export interface DiagnosticCheck {
    id: 'config' | 'device' | 'runtimes' | 'environment' | 'control' | 'lifecycle' | 'clock-skew' | 'health' | 'journal' | 'quarantine';
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
        /** #1103: the effective version policy's verdict. Absent from an older daemon, or a custom adapter with no policy. */
        versionVerdict?: RuntimeVersionVerdict;
        /** #1103 §2.6: the local restart comparison. Absent on a first run, an unchanged version or an older daemon. */
        versionChange?: RuntimeVersionChange;
        /** #1103 O10: the executable detection ran and who chose it. Local-only; a support bundle drops both. */
        executablePath?: string;
        executableSource?: RuntimeExecutableSource;
        authPresent?: boolean;
        steer: boolean;
        resume: boolean;
    }>;
    runtimeSource: 'daemon' | 'local-shell' | 'unknown';
    environment: ServiceEnvironmentRecord | {
        status: 'unknown';
    };
    control: {
        status: 'offline';
        reason: string;
    } | {
        status: 'online';
        pid: number;
        uptimeMs: number;
        activeTaskCount: number;
        pendingApprovalCount: number;
        operationalHealth: ControlStatusResult['operationalHealth'];
        outbound?: ControlStatusResult['outbound'];
        storage: ControlStatusResult['storage'];
    };
    /**
     * Issue #394: the running daemon's lifecycle (`live`), else the last
     * `lifecycle` event in `audit.jsonl` (`audit`), else `unknown`.
     */
    lifecycle: {
        status: 'unknown';
    } | {
        status: 'known';
        source: 'live' | 'audit';
        lifecycle: DaemonLifecycle;
    };
    /**
     * #1114: the device clock against the server's HTTP `Date` header at the
     * running daemon's last pair or renewal. Unknown while the daemon is
     * offline: doctor stays network-free and keeps no state file of its own.
     */
    clockSkew: {
        status: 'unknown';
        reason: 'daemon-offline' | 'not-observed';
    } | {
        status: 'measured';
        deviceAheadMs: number;
        uncertaintyMs: number;
        observedAt: string;
    };
    health: OperationalHealthFileInspection;
    journal: {
        status: 'missing' | 'present' | 'corrupt' | 'unavailable';
        sizeBytes?: number;
        walBytes?: number;
        integrity?: 'ok' | 'not-checked';
        failedTerminalCount?: number;
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
    /** #1097: the daemon log and the service manager's redirect files under `serviceLogDir(storeDir)`. */
    logs: {
        status: 'present' | 'missing' | 'unavailable';
        totalBytes: number;
        files: Array<{
            kind: 'daemon' | 'service-manager';
            sizeBytes: number;
        }>;
        truncated: boolean;
    };
    /**
     * #1095: the running daemon's runtime environments as counts. Names stay
     * out of the snapshot and the support bundle: only `doctor` prints them.
     */
    runtimeEnvironment: {
        status: 'unknown';
        reason: 'daemon-offline' | 'request-failed';
    } | {
        status: 'known';
        runtimes: Array<{
            idHash: string;
            status: 'built';
            names: number;
            removed: number;
        } | {
            idHash: string;
            status: 'unavailable';
            code: ServiceEnvironmentUnavailableCode;
        } | {
            idHash: string;
            status: 'failed';
        }>;
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
export type { RuntimeAdapter, RuntimeAdapterDescriptor, RuntimeAdapterPrepareInput, RuntimeTaskInput, RuntimeAdapterPrepareResult, RuntimeAdapterRejectedOperation, RuntimeAdapterPreparedOperation, PreparedRuntimeOperation, RuntimeSessionLease, RuntimeOperationManifest, RuntimeOperationStartInput, RuntimeCapabilities, RuntimeIsolationCapabilities, RuntimeVersionPolicy, RuntimeVersionSpec, RuntimeVersionVerdict, RuntimeDetectResult, RuntimeDetectionAdvisory, RuntimeDetectionRefusalReason, RuntimeExecutableSource, Session, MessageDraftDelta, SessionEvidence, McpStdioServerConfig, McpToolsetConfig, McpToolsetLifecycleState, McpToolsetObservation, McpToolsetStatus, McpToolsetRegistryStatus, McpToolsetReloadReceipt, AgentEgressPolicy, } from './types';
export type { AgentRef } from './agent-home';
export { AgentHomeError, AgentRefValidationError, AgentHomeResolutionError, AgentHomeCollisionError, AgentHomeBusyError, AgentHomeLeaseCorruptError, AgentHomeReaderRunMissingError, AgentHomeLayout, AgentHomeLeaseManager, AgentHomeManager, createAgentHomeProjection, createAgentHomeProjectionConsumer, AGENT_HOME_PROJECTION_STATE_FILE, stableAgentHomeOwnerId, validateAgentRef, } from './agent-home';
export { AgentSessionHandoffStore, AgentSessionHandoffStoreError, AgentSessionHandoffCorruptError, AgentSessionHandoffMismatchError, } from './daemon/agent-session-handoff-store';
export type { AgentSessionHandoff, AgentSessionHandoffMatch, AgentTaskTerminalEvidence, AgentTaskTerminalMatch, AgentTerminalCause, } from './daemon/agent-session-handoff-store';
export type { AgentHomeResolution, AgentHomeProjection, AgentHomeProjectionInput, AgentHomeProjectionApplyInput, AgentHomeProjectionFunction, AgentHomeProjectionApplyFunction, AgentHomeLease, AgentHomeBinding, AgentHomeExecutionLease, AgentHomeExecutionBinding, AgentHomeExecutionStatus, } from './agent-home';
export type { AgentHomeAccessMode } from './agent-home-readers';
export { localStateRelocation, LocalStateRelocationError, LocalStateRelocationBusyError, LocalStateRelocationIntegrityError, } from './local-state-relocation';
export type { LocalStateRelocationInput, LocalStateRelocationLease, } from './local-state-relocation';
export { PolicyUnsupportedError, SteerUnsupportedError, freezeRuntimeAdapterDescriptor, sealRuntimeOperationManifest } from './types';
export { resolveLocalAgentReleaseIdentity } from './release-identity';
export type { LocalAgentReleaseIdentity } from './release-identity';
export { BYOK_SDK_HELPER_SUBCOMMAND, bundledSdkHelperHost, resolveSdkReservedHelperBin, } from './sdk-reserved-helper-host';
export { runSdkReservedHelperCommand } from './lifecycle/sdk-reserved-helper-command';
export type { SdkHelperHostConfig, SdkReservedHelperKind, ResolvedSdkReservedHelperBin, } from './sdk-reserved-helper-host';
export { RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeStartupDisposalFailure, RuntimeDisposalFailure, RUNTIME_ADAPTER_CONTRACT_VIOLATION_REASON, isRuntimeDisposalFailure, isRuntimeExecutionFailure, projectRuntimeBoundaryFailure, projectRuntimeExecutionFailure, } from './runtime-failure';
export type { RuntimeExecutionFailureInput, RuntimeDisposalFailureInput, RuntimeDisposalStage, RuntimeFailureCategory, RuntimeFailurePhase, RuntimeFailureProjection, RuntimeRetryDisposition, } from './runtime-failure';
export { createDaemon, createDaemonWithAdapters } from './daemon/create-daemon';
export { DAEMON_CONFIG_SCHEMA_VERSION, DaemonConfigInvalidError, checkDaemonConfig, validateDaemonConfig, type DaemonConfigCheck, type DaemonConfigCheckOptions, type DaemonConfigIssue, type DaemonConfigIssueCode, type DaemonConfigSource, type DaemonConfigValidation, type DaemonEffectiveConfig, type DaemonEffectiveMcpServer, type DaemonEffectiveRuntime, type DaemonEffectiveToolAuthorization, type DaemonMemoryHelperResolution, } from './daemon/config-schema';
export { DaemonConfigFieldRemovedError, DaemonJournalProtocolUnsupportedError, DeviceStoreBindingMismatchError, HostLayoutInputError, type DaemonJournalProtocolRecord, } from './daemon/daemon-errors';
export { resolveHostLayout, type HostLayout, type HostLayoutOptions, type HostLayoutPlatform, } from './daemon/host-layout';
/** #1101: approvals carry their kind; the control socket cannot approve a tool authorization by default. */
export { APPROVAL_REQUIRES_HOST } from './daemon/approvals';
export type { ApprovalKind, LocalToolApprovalPolicy } from './daemon/approvals';
export { RESULT_NOT_SUBMITTED_REASON_PREFIX, RESULT_UNREADABLE_REASON_PREFIX } from './daemon/task-runner/state';
export { LocalTeamWorkspace, LocalTeamWorkspaceService, TeamWorkspaceError, TeamWorkspaceValidationError, TeamWorkspaceNotFoundError, TeamWorkspaceConflictError, TeamWorkspaceQuotaError, TeamWorkspaceLeaseError, TeamWorkspaceReceiptError, TeamWorkspaceCorruptError, encodeTeamMemberContext, decodeTeamMemberContext, type TeamWorkspaceDefinition, type TeamWorkspaceLimits, type TeamMessage, type TeamMemberLease, type TeamWorkspaceMemberReceipt, } from './daemon/team-workspace';
export { openTeamTmuxView, TeamTmuxViewError, type OpenTeamTmuxViewInput } from './util/team-tmux-view';
export type { Daemon, DaemonConfig, DaemonStatus, DaemonOverrides, DaemonBranding, DeviceAssertionConfig, InputPreparationDaemonConfig, AgentEgressConfig, AgentContentReadConfig, AgentContentReadSurfaceConfig, AgentReliableEgressInput, } from './daemon/create-daemon';
export { ProviderProvisioningNoticeError, PROVIDER_PROVISIONING_NOTICE_FAILURE_REASONS, } from './daemon/provider-provisioning';
export type { ProviderProvisioningHandler, ProviderProvisioningNotice, ProviderProvisioningNoticeFailureReason, } from './daemon/provider-provisioning';
export { AgentMemoryIntentNoticeError, AGENT_MEMORY_INTENT_NOTICE_FAILURE_REASONS, } from './daemon/agent-memory-intent';
export type { AgentMemoryIntentNoticeFailureReason, } from './daemon/agent-memory-intent';
export { AgentMemorySnapshotLimitError, AgentMemoryRevisionConflictError, isAgentMemorySecureFilesystemAvailable, AGENT_MEMORY_AUDIT_FILENAME, AGENT_MEMORY_OUTBOX_FILENAME, } from './daemon/agent-memory';
export type { AgentMemoryRedactor, AgentMemoryProjectionGrant, AgentMemoryHostedProjection, } from './daemon/agent-memory';
export type { AgentEgressDropReceipt, AgentEgressLaneStatus, AgentEgressStatus, } from './daemon/agent-egress-policy';
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
export type { InputPreparationArtifactSummaryV1, InputPreparationAuthorityGrantV1, InputPreparationCompiledPromptSnapshotV1, InputPreparationCompiledSnapshotV1, InputPreparationAuthorityOutcomeV1, InputPreparationAuthorityResolver, InputPreparationSourceAuthorityRequestV1, InputPreparationSourceAuthorityOutcomeV1, InputPreparationBindingV1, InputPreparationCancelParamsV1, InputPreparationCounterAdapter, InputPreparationCounterAuthorityV1, InputPreparationCounterEvidenceV1, InputPreparationCounterRequestV1, InputPreparationCounterResultV1, InputPreparationCounterTargetV1, InputPreparationCoverageProofV1, InputPreparationDenialReasonV1, InputPreparationErrorCodeV1, InputPreparationHostCanonicalAssistantMessageV1, InputPreparationLimitsPolicyV1, InputPreparationLookupParamsV1, InputPreparationModelCostV1, InputPreparationMessageV1, InputPreparationModelV1, InputPreparationOptionsV1, InputPreparationPinV1, InputPreparationPromptSnapshotV1, InputPreparationReadinessReasonV1, InputPreparationReceiptV1, InputPreparationRequestV1, InputPreparationRuntimeIdentityV1, InputPreparationScopeClaimV1, InputPreparationSelectionV1, InputPreparationSnapshotV1, InputPreparationSourceV1, InputPreparationStateV1, InputPreparationToolV1, InputPreparationUserMessageV1, } from './input-preparation';
export { INPUT_PREPARATION_CANCEL_METHOD, INPUT_PREPARATION_IDENTIFIER_MAX_BYTES, INPUT_PREPARATION_LOOKUP_METHOD, INPUT_PREPARATION_PREPARE_METHOD, parseInputPreparationCancelParams, parseInputPreparationLookupParams, parseInputPreparationRequestParams, } from './daemon/control-protocol';
export type { InputPreparationResult } from './daemon/control-protocol';
export { journalHash, JournalUnavailableError, JournalCorruptError, JournalRecordTooLargeError, JournalUnknownTaskError, JournalClosedError, } from './daemon/journal/journal';
export type { LocalTaskJournal, JournalIdentity, JournalReceipt, ReceivedEnvelopeRecord, AdmissionRecord, LocalTransitionRecord, LocalTerminalRecord, TerminalTruthState, RecoverableTask, WithheldOfferRecord, WithheldOfferTask, RecoveryOutcome, RecoveryDisposition, LocalStorageUsage, CompactOptions, CompactResult, } from './daemon/journal/journal';
export { SqliteLocalTaskJournal, JOURNAL_DB_FILENAME, JOURNAL_QUARANTINE_DIRNAME } from './daemon/journal/sqlite-journal';
export type { SqliteLocalTaskJournalOptions } from './daemon/journal/sqlite-journal';
export { inspectDaemonStores } from './diagnostics/store-compatibility';
export type { InspectDaemonStoresInput } from './diagnostics/store-compatibility';
export { LocalStorageConfigError, resolveStorageConfig, DEFAULT_RETENTION_TTL_MS } from './daemon/retention/config';
export type { StorageConfig, StorageBudgetInput } from './daemon/retention/config';
export { LocalStorageEmergencyError } from './daemon/retention/pressure';
export type { StoragePressureState } from './daemon/retention/pressure';
export type { ExpiringClassId, ProtectedClassId, RetentionClassId, ClassUsage, SweepReport } from './daemon/retention/registry';
export { readDeviceEnrollmentStatus, readDeviceEnrollmentIdentity } from './daemon/store';
export { DeviceCredentialStoreError, DeviceCredentialStoreUnavailableError, DeviceCredentialInteractionRequiredError, DeviceCredentialCommandAbortedError } from './daemon/device-credential-store';
export { AuthResponseInvalidError } from './daemon/auth-manager';
export type { DeviceCredentialBackend, DeviceCredentialConfig } from './daemon/device-credential-store';
export type { DeviceEnrollment, DeviceEnrollmentIdentity, DeviceEnrollmentIdentityStatus, DeviceEnrollmentStatus, DeviceEnrollmentStatusOptions, } from './daemon/store';
/**
 * Host device proofs signed with the stored enrollment key, scoped to one
 * enrollment identity and an explicit operation allowlist. The key never
 * leaves the signer; `DeviceProofSigner` is also what `TruthMemoryClient` takes.
 */
export { createStoredDeviceProofSigner, DeviceProofSignerError } from './daemon/device-proof-signer';
export type { CreateStoredDeviceProofSignerOptions, DeviceProofRequest, DeviceProofSigner, DeviceProofSignerErrorCode, HostDeviceProofSigner, } from './daemon/device-proof-signer';
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
export { DAEMON_HALT_REASONS, DaemonHaltError, isDaemonHaltReason } from './daemon/daemon-lifecycle';
export type { DaemonHaltReason, DaemonLifecycle } from './daemon/daemon-lifecycle';
export { ReplayCursorTooOldError } from './daemon/replay-cursor';
export { BlobClient, BlobRequestAbortedError } from './daemon/blob-client';
export type { BlobClientOptions, BlobRequestAbortReason, BlobRequestOptions, BlobResolver } from './daemon/blob-client';
export { DaemonObserver } from './daemon/observer';
export type { DaemonEvent, DaemonEventKind, DaemonEventListener, DaemonTaskInfo, Unsubscribe } from './daemon/observer';
export { createDaemonRecordProjector, DAEMON_RECORD_KINDS, isDaemonRecordKind } from './daemon/daemon-record';
export type { DaemonRecord, DaemonRecordKind, DaemonRecordProjector, DaemonTurnRecord } from './daemon/daemon-record';
export type { ExecutionRecord, ExecutionRecordGap, ExecutionRecordStatus, ExecutionRecordUnknown } from './daemon/execution-record';
export { createServiceLifecycle, UnsupportedServicePlatformError } from './lifecycle/create-service-lifecycle';
export type { CreateServiceLifecycleOptions } from './lifecycle/create-service-lifecycle';
export { nodeAgentProgram, sanitizeServiceName } from './lifecycle/service-types';
export type { NodeAgentProgramOptions, ServiceDefinition, ServiceInstallOptions, ServiceLifecycle, ServiceProgram, ServiceStatusResult, } from './lifecycle/service-types';
export { generateLaunchdPlist } from './lifecycle/launchd';
export { generateSystemdUnit } from './lifecycle/systemd';
export { generateWinswXml } from './lifecycle/winsw';
export { AGENT_PAYLOAD_ENTRY, agentServiceDefinition, agentServiceInstallation } from './lifecycle/agent-service';
export type { AgentServiceDefinitionInput, AgentServiceInstallationInput } from './lifecycle/agent-service';
export { createServiceInstallation, readPayloadManifest, readServiceInstallationRecord, SERVICE_PAYLOAD_MANIFEST, ServiceInstallationError, } from './lifecycle/service-installation';
export type { ServiceInstallation, ServiceInstallationErrorCode, ServiceInstallationOptions, ServiceInstallationRecord, ServicePayloadManifest, ServiceUpgradeReceipt, } from './lifecycle/service-installation';
export { claimServiceLifecycleOwner, generateServiceLauncher, readServiceLifecycleOwner, releaseServiceLifecycleOwner, ServiceUnitError, } from './lifecycle/service-unit';
export type { ServiceLifecycleOwnerInput, ServiceRepairResult, ServiceUnitErrorCode, ServiceUnitInspection, ServiceUnitState, } from './lifecycle/service-unit';
export { EXIT_CODE_CONTRACT, serviceExitDisposition } from './lifecycle/exit-codes';
export type { ExitCode, ServiceExitDisposition } from './lifecycle/exit-codes';
export { DAEMON_LOG_LIMITS, inspectServiceLogs, openDaemonLog, SERVICE_REDIRECT_LIMITS } from './lifecycle/service-log';
export type { DaemonLog, DaemonLogOptions, ServiceLogReport } from './lifecycle/service-log';
export { applyLoginShellEnvironment } from './lifecycle/service-environment';
export { serviceEnvironmentStatus } from './login-shell-environment';
export { buildRuntimeEnvironment, RuntimeEnvironmentUnavailableError } from './runtime/environment';
export type { RuntimeEnvironment, RuntimeEnvironmentConflictRule, RuntimeEnvironmentPolicy, RuntimeEnvironmentRemovalRule, RuntimeEnvironmentReport, RuntimeEnvironmentSource } from './runtime/environment';
export type { RuntimeObservation, RuntimeVersionChange, RuntimeVersionChangeDirection } from './runtime-detection';
export type { ServiceEnvironmentRecord, ServiceEnvironmentStatus, ServiceEnvironmentUnavailableCode } from './login-shell-environment';
export { ensureSecureDir, buildIcaclsArgs, SecureDirHardeningError } from './util/secure-dir';
export type { EnsureSecureDirOptions } from './util/secure-dir';
export { PiAdapter } from './adapters/pi/pi-adapter';
export type { PiAdapterOptions, PiByokLauncherConfig } from './adapters/pi/pi-adapter';
export { PI_PACKAGE_NAME } from './adapters/pi/resolve-bin';
export { copyPiRuntimeAssets } from './adapters/pi/runtime-assets';
export type { CopyPiRuntimeAssetsOptions, PiRuntimeAssetForm } from './adapters/pi/runtime-assets';
export { ClaudeAdapter } from './adapters/claude/claude-adapter';
export type { ClaudeAdapterOptions } from './adapters/claude/claude-adapter';
export { CodexAdapter, type CodexAdapterOptions, type CodexSandboxSetting } from './adapters/codex/codex-adapter';
export { GrokAdapter, type GrokAdapterOptions } from './adapters/grok/grok-adapter';
export { HermesAdapter, type HermesAdapterOptions, type HermesModelSelection, type HermesByokLauncher } from './adapters/hermes/hermes-adapter';
export { diagnoseDevice, repairDeviceEnrollmentMetadata, DeviceMetadataRepairError, resetDeviceCursor, DeviceCursorResetError } from './diagnostics/device-doctor';
export type { DiagnoseDeviceOptions, DiagnosticsSnapshot, DiagnosticCheck, DiagnosticStatus, RepairDeviceEnrollmentMetadataInput, DeviceMetadataRepairResult, DeviceMetadataRepairErrorCode, ResetDeviceCursorInput, DeviceCursorResetResult, DeviceCursorResetErrorCode, } from './diagnostics/device-doctor';
export { quarantineDeviceOperationalHealth, exportDeviceSupportBundle, archiveAgentTerminalMessages, DeviceOperatorError } from './diagnostics/operator-actions';
export type { ConfirmDeviceMaintenanceInput, DeviceHealthQuarantineResult, ExportDeviceSupportBundleInput, DeviceSupportBundleExportResult, ArchiveAgentTerminalMessagesInput, AgentTerminalMessagesArchiveResult, DeviceOperatorErrorCode } from './diagnostics/operator-actions';
export { NativeInteractionController, NativeInteractionError } from './native-interactions';
export type { NativeApprovalDecision, NativeInteractionCapabilities, NativeInteractionIdentity, NativeQuestion, NativeQuestionAnswer, NativeInteractionInput, NativeInteractionRequest, NativeInteractionResponse, NativeInteractionReceipt, NativeInteractionEndReason, NativeInteractionChannel, NativeInteractionOptions, NativeInteractionHostOptions, NativeInteractionTransport, NativeInteractionErrorCode, } from './native-interactions';
export type { OutboundStatus, OutboundRejection } from './daemon/outbound-settlement';
export { createExecutionScratch, ScratchRootPathError } from './daemon/retention/scratch';
export type { ExecutionScratch } from './daemon/retention/scratch';
export { copyAgentMemoryHelperAssets, type CopyAgentMemoryHelperAssetsOptions } from './util/agent-memory-helper-release';
/** The reserved name of the SDK memory MCP server in an Agent task's MCP servers. */
export { AGENT_MEMORY_MCP_SERVER_NAME } from './sdk-reserved-mcp';
/** Whether `name` is the name of an MCP server the SDK owns in a task's MCP servers. */
export { isReservedMcpServerName } from './sdk-reserved-mcp';
export { copySdkNativeAssets, sdkNativeAssetTargets, sdkDistributionManifest, sdkPackagingAssetLayout, sdkPackagingFormats, type CopySdkNativeAssetsOptions, type SdkDistributionBin, type SdkDistributionBinRole, type SdkPackagingFormat } from './sdk-native-assets';
export type { AgentMemoryExportOptions } from './daemon/agent-memory-export';
export { classifyToolCall, createAutoToolAuthorizationGate, FileScopePolicyError, parseToolAuthorizationMode, parseToolAuthorizationPolicy, SENSITIVE_HOME_PATHS, TOOL_AUTHORIZATION_MODES, TOOL_FILE_ACCESS, } from './tool-authorization';
export type { ToolAuthorizationDenialCode, ToolAuthorizationGate, ToolAuthorizationHomeAccess, ToolAuthorizationLane, ToolAuthorizationMode, ToolAuthorizationTask, ToolAuthorizationVerdict, ToolCall, ToolFileAccess, ToolFileScope, ToolFileScopeRoot, ToolReminder, ToolRisk, ToolRiskReason, ToolAuthorizationDecision, ToolAuthorizationPolicy, ToolAuthorizationReason, ToolAuthorizationRules, ToolRule, } from './tool-authorization';
// ==== @byok-sdk/client dist/input-preparation.d.ts ====
import type { PreparedAgentMemoryState } from './agent-memory/prepared-agent-memory';
import type { PreparedAgentMemoryMode, TerminalProjectionSelection } from '@byok-sdk/protocol';
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
 * Version 7 uses Host systemPrompt and the official Pi v4 envelope/identity.
 * The fourteen admission comparisons remain; old artifacts are not read forward.
 *
 * Version 9 REMOVED `permissionMode` from the request and the binding, with the
 * task offer's permission policy (protocol v2). A preparation counts every
 * observed MCP tool; there is no mode to filter for or to compare.
 * Version 9 also replaced the artifact's `toolImplementationKinds` with
 * `toolNames` and removed the readiness reason `executor_identity_unproven`:
 * the SDK does not attest tool executables. Version 9 is not released yet, so
 * this change amends it.
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
export declare const INPUT_PREPARATION_VERSION: 9;
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
/** Complete Host-authored prompt, carried verbatim. Prepared runs have no Pi default prompt. */
export interface InputPreparationPromptSnapshotV1 {
    readonly systemPrompt: string;
}
export type InputPreparationCompiledPromptSnapshotV1 = InputPreparationPromptSnapshotV1;
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
 * There is no `runtimeIdentity`, `compilerVersion` or `policyIdentity` field:
 * those are derived from the pinned official Pi release and the
 * daemon's own configured policy, never from caller text.
 */
export interface InputPreparationRequestV1 {
    /** Frozen result selection; its tool schema participates in the counted manifest. */
    readonly terminalProjection?: TerminalProjectionSelection;
    readonly agentMemory: PreparedAgentMemoryMode;
    readonly format: typeof INPUT_PREPARATION_REQUEST_FORMAT;
    readonly version: typeof INPUT_PREPARATION_VERSION;
    readonly requestId: string;
    /** Must equal the daemon's configured {@link InputPreparationLimitsPolicyV1.revision} exactly. */
    readonly policyRevision: string;
    readonly scope: InputPreparationScopeClaimV1;
    readonly source: InputPreparationSourceV1;
    readonly selection: InputPreparationSelectionV1;
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
export declare const INPUT_PREPARATION_RETIRED_PROMPT_KEYS: readonly ['selectedTools', 'customPrompt', 'appendSystemPrompt', 'cwd', 'toolSnippets', 'toolGuidelines', 'promptGuidelines', 'contextFiles', 'skills', 'docsPaths'];
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
    readonly agentMemory: PreparedAgentMemoryMode;
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
    readonly tarballIntegrity: string;
    readonly provenanceDigest: string;
    readonly closureDigest: string;
    readonly upstreamCommit: string;
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
     * projected tools and their executor fingerprints. A later consumer
     * re-observes and compares this one value rather than re-deriving a manifest.
     */
    readonly observationDigest: string;
    /**
     * Digest of the subset of those facts that can be re-derived WITHOUT
     * spawning a server: the toolset definition revisions and the configured
     * argv. This is what a replay of an already-recorded `requestId` compares
     * against, because re-probing to detect drift would create the second
     * executor fact the idempotency key exists to prevent.
     */
    readonly toolBindingDigest: string;
    /** The counted model-visible tool names, sorted byte-wise. */
    readonly toolNames: readonly string[];
}
/** The immutable binding a receipt carries and a later consumer must re-present. */
export interface InputPreparationBindingV1 {
    readonly terminalProjection?: TerminalProjectionSelection;
    readonly agentMemory: PreparedAgentMemoryMode;
    readonly scopeId: string;
    readonly deviceId: string;
    readonly agentRef: string;
    readonly profileId: string;
    readonly profileRevision: string;
    readonly source: InputPreparationSourceV1;
    readonly target: InputPreparationCounterTargetV1;
    readonly policyRevision: string;
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
 * is ruled by an applicable Host accounting policy, D is text only, and —
 * only when a counter is configured — that count is provider-authoritative
 * and covered. It says nothing about
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
export type InputPreparationReadinessReasonV1 = 'not_prepared' | 'counter_interrupted' | 'cancelled' | 'failed' | 'artifact_expired' | 'counter_authority_not_production' | 'counter_coverage_incomplete' | 'request_content_not_text' | 'projection_unknown' | 'residual_not_ruled' | 'accounting_policy_missing' | 'accounting_policy_inapplicable' | 'runtime_contract_superseded';
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
 * - `runtime_identity_unavailable` — the pinned Pi runtime identity could not
 *   be resolved, so no artifact can carry a runtime identity.
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
 * A repeat of an already-recorded `requestId` arrived after the facts its
 * executor fingerprints were frozen against changed. The recorded receipt is
 * not re-derived and no server is re-probed.
 */
'observation_drift', 
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
}
export interface PreparedToolBindingDigestInputV1 {
    readonly agentMemory: PreparedAgentMemoryMode;
    readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
    /** Canonically ordered by server name; the canonical JSON preserves array order. */
    readonly servers: readonly PreparedToolBindingServerDigestInputV1[];
}
/** The spawn-free half: the definition revisions and the configured argv. */
export declare function preparedToolBindingDigest(input: PreparedToolBindingDigestInputV1): string;
export interface PreparedToolSurfaceDigestInputV1 {
    readonly agentMemory: PreparedAgentMemoryMode;
    readonly memory: PreparedAgentMemoryState | null;
    readonly runtimeIdentity: string;
    readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
    readonly tools: readonly InputPreparationToolV1[];
    readonly toolExecutors: Readonly<Record<string, string>>;
}
/** The whole observed surface: the schemas and the executors. */
export declare function preparedToolSurfaceObservationDigest(input: PreparedToolSurfaceDigestInputV1): string;
// ==== @byok-sdk/client dist/lifecycle/agent-service.d.ts ====
import type { DaemonConfig } from '../daemon/create-daemon';
import type { ServiceInstallationOptions } from './service-installation';
import { type ServiceDefinition } from './service-types';
export interface AgentServiceDefinitionInput {
    config: Pick<DaemonConfig, 'productId' | 'productName' | 'storeDir' | 'branding'>;
    /** The config file `byok-agent start` loads; resolved to an absolute path, since the service starts in the manager's own working directory. */
    configPath: string;
    /** Absolute path of the `byok-agent` entry script. */
    agentBin: string;
    /** Node executable that runs `agentBin`. Default: `process.execPath`. */
    nodeBin?: string;
    /** See {@link ServiceDefinition.owner}. */
    owner: string;
    /** Default: `config.productId`. */
    name?: string;
    windows?: ServiceDefinition['windows'];
}
/**
 * The service definition for `node <agentBin> start --config <configPath>
 * --service` (#1097): the one implementation `byok-agent install` and an
 * embedded Host share. Every default derives from `config`, so install,
 * uninstall and status compute the same name, store and log directory.
 *
 * `--service` makes `start` capture the login-shell environment (#392) and
 * exit 0 on a halt (#394, `exit-codes.ts`). The log directory is
 * `resolveHostLayout`'s `logDir` for this store.
 */
export declare function agentServiceDefinition(input: AgentServiceDefinitionInput): ServiceDefinition;
/** The entry a `byok-agent` payload ships at its root: a single-file bundle (`@byok-sdk/client/packaging`). */
export declare const AGENT_PAYLOAD_ENTRY = "byok-agent.mjs";
export interface AgentServiceInstallationInput extends Omit<AgentServiceDefinitionInput, 'agentBin'> {
    /** See {@link ServiceInstallationOptions.installRoot}. */
    installRoot: string;
}
/**
 * The installation of a `byok-agent` payload (#1097): `byok-agent install
 * --payload` and an embedded Host that ships the agent bundle share it. The
 * service runs `node <installRoot>/current/byok-agent.mjs start --config
 * <configPath> --service`; the precheck runs the candidate's own `upgrade
 * check --store --json` against the same config.
 */
export declare function agentServiceInstallation(input: AgentServiceInstallationInput): ServiceInstallationOptions;
// ==== @byok-sdk/client dist/lifecycle/create-service-lifecycle.d.ts ====
import { type LaunchdDeps } from './launchd';
import { type SystemdDeps } from './systemd';
import { type WinswDeps } from './winsw';
import type { ManagedServiceLifecycle } from './managed-lifecycle';
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
/** @internal `createServiceLifecycle` with the owner gate a service installation runs its steps behind. */
export declare function createManagedServiceLifecycle(def: ServiceDefinition, opts?: CreateServiceLifecycleOptions): ManagedServiceLifecycle;
// ==== @byok-sdk/client dist/lifecycle/exit-codes.d.ts ====
/**
 * The process exit-code contract of `byok-agent` and its helper
 * executables (#394, #1097). Every exit status the source uses is a key
 * here; `exit-codes.test.ts` scans `src/bin` and fails on any other.
 *
 * `service` is what a service manager does when the process exits with
 * that status. Only 0 stops a service, and every generated unit says so:
 * launchd `KeepAlive.SuccessfulExit = false`, systemd `Restart=always` with
 * `RestartPreventExitStatus=0`, WinSW `<onfailure action="restart">` (which
 * fires on a non-zero exit only). A service runs `start --service`, which
 * exits only 0 (stopped or halted) or 1 (crashed).
 */
export declare const EXIT_CODE_CONTRACT: Readonly<{
    readonly 0: {
        readonly meaning: 'success: a command finished, or the daemon stopped or (under --service) halted';
        readonly service: 'stop';
    };
    readonly 1: {
        readonly meaning: 'failure: a command failed, or the daemon crashed';
        readonly service: 'restart';
    };
    readonly 2: {
        readonly meaning: 'upgrade check --store: a store would be refused';
        readonly service: 'restart';
    };
    readonly 78: {
        readonly meaning: 'EX_CONFIG: the daemon halted outside --service, or a helper refused its configuration';
        readonly service: 'restart';
    };
}>;
export type ExitCode = keyof typeof EXIT_CODE_CONTRACT;
export type ServiceExitDisposition = (typeof EXIT_CODE_CONTRACT)[ExitCode]['service'];
export declare const EXIT_SUCCESS = 0;
export declare const EXIT_FAILURE = 1;
export declare const EXIT_CONFIG = 78;
/** What a service manager does after `code`; a status outside the contract (a signal, an unknown code) restarts. */
export declare function serviceExitDisposition(code: number): ServiceExitDisposition;
/** How `start` ended without crashing; a crash is a throw and exits {@link EXIT_FAILURE}. */
export interface DaemonExitOutcome {
    readonly kind: 'stopped' | 'halted';
}
/**
 * `start`'s exit status: 0 for a stop, {@link EXIT_CONFIG} for a halt (a
 * restart cannot fix it). Under `--service` a halt exits 0, the one status
 * every supported service manager leaves stopped.
 */
export declare function daemonExitCode(outcome: DaemonExitOutcome, service: boolean): ExitCode;
// ==== @byok-sdk/client dist/lifecycle/launchd.d.ts ====
import { type Runner } from '../util/exec-runner';
import { type ManagedLifecycleFs, type ManagedServiceLifecycle } from './managed-lifecycle';
import { type ServiceDefinition } from './service-types';
/** DI seam for tests — see `exec-runner.ts`'s `Runner` doc comment for why a mocked `run` is enough to unit-test all of this file's install/uninstall/start/stop/status logic on any host OS. */
export interface LaunchdDeps {
    run?: Runner;
    fs?: ManagedLifecycleFs;
    homedir?: () => string;
    /** Defaults to `process.getuid` — macOS/Linux only; this module is never constructed on `win32` (see `create-service-lifecycle.ts`). */
    getuid?: () => number;
    /** Clock and wait for the unload deadline; tests drive them. */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}
/** How long a booted-out job may stay in the domain before `stop()` gives up with `service_unload_timeout`. */
export declare const LAUNCHD_UNLOAD_TIMEOUT_MS = 10000;
/**
 * Generates a launchd LaunchAgent plist for `label` that runs only the
 * stable `launcherPath` (#1097), logging to `logDir`. Pure/no I/O.
 *
 * - The {@link SERVICE_UNIT_MARKER} comment marks the plist as ours; see `service-unit.ts`.
 * - `RunAtLoad`: true — starts immediately on `launchctl bootstrap`.
 * - `KeepAlive.SuccessfulExit: false` — restart after any exit but 0, the
 *   exit-code contract in `exit-codes.ts`. Nothing in this SDK supervises
 *   the process itself.
 * - `ThrottleInterval: 10` — matches systemd `RestartSec=10` and WinSW's
 *   first `onfailure` delay.
 * - `StandardOutPath`/`StandardErrorPath` receive only early-boot crash
 *   output; the daemon writes its own rotated log (`service-log.ts`).
 */
export declare function generateLaunchdPlist(def: {
    label: string;
    launcherPath: string;
    workingDirectory: string;
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
export declare function createLaunchdLifecycle(def: ServiceDefinition, deps?: LaunchdDeps): ManagedServiceLifecycle;
// ==== @byok-sdk/client dist/lifecycle/managed-lifecycle.d.ts ====
import { promises as fsp } from 'node:fs';
import { type ServiceUnitFile } from './service-unit';
import type { ServiceDefinition, ServiceInstallOptions, ServiceLifecycle, ServiceStatusResult } from './service-types';
export type ManagedLifecycleFs = Pick<typeof fsp, 'mkdir' | 'writeFile' | 'readFile' | 'rm' | 'rename' | 'chmod'>;
/** The platform half of a lifecycle: where its files go and how its manager loads them. */
export interface PlatformUnit {
    serviceName: string;
    unitPath: string;
    launcherPath: string;
    /** The unit first, then the launcher, with their exact expected content. */
    files(): ServiceUnitFile[];
    /** Runs after the files are written: register with the manager and start. Throws if it does not end running. */
    activate(): Promise<void>;
    /** Stops and unregisters. Tolerates only a known "not loaded"; a real failure throws and the files stay. */
    deactivate(): Promise<void>;
    /** Removes every file `files()` lists, plus platform extras. Runs only after `deactivate()` succeeded. */
    removeFiles(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    query(): Promise<Pick<ServiceStatusResult, 'running' | 'determinate' | 'detail'>>;
    /** Extra preparation before the files are written (WinSW copies its executable). */
    prepare?(): Promise<void>;
    /** Whether what `prepare()` puts in place is already exact; asked only once `files()` classify exact. */
    preparedArtifactsExact?(): Promise<boolean>;
}
/** install and uninstall for an operation already inside `owned()`, which holds the owner gate they would take. */
export interface HeldServiceLifecycle {
    install(opts?: ServiceInstallOptions): Promise<void>;
    uninstall(): Promise<void>;
}
/** A lifecycle whose owner check other installation steps run behind (#1097). */
export interface ManagedServiceLifecycle extends ServiceLifecycle {
    /**
     * Runs `operation` inside the store's owner gate, after the same owner
     * check install, repair and uninstall make: another recorded owner throws
     * `lifecycle_owner_conflict` before `operation` writes anything.
     */
    owned<T>(operation: (held: HeldServiceLifecycle) => Promise<T>): Promise<T>;
}
/**
 * The install, repair, uninstall and status rules all three platforms share
 * (#1097): a `foreign` unit is never changed (`install` replaces it only
 * with `replaceUnmarked`), one lifecycle owner per product store, and the
 * unit and launcher are written whole on every install or repair. install,
 * repair and uninstall run whole inside the store's owner gate, so the owner
 * they checked is still the owner when they write, deactivate or release.
 */
export declare function createManagedLifecycle(def: ServiceDefinition, unit: PlatformUnit, fs?: ManagedLifecycleFs): ManagedServiceLifecycle;
// ==== @byok-sdk/client dist/lifecycle/sdk-reserved-helper-command.d.ts ====
/**
 * Product entrypoint seam for single-file/SEA hosts. Returns `false` without
 * side effects for normal product commands; a reserved command is handled to
 * stdio EOF before this resolves `true`.
 */
export declare function runSdkReservedHelperCommand(argv?: readonly string[]): Promise<boolean>;
// ==== @byok-sdk/client dist/lifecycle/service-environment.d.ts ====
import { type ApplyLoginShellEnvironmentOptions, type ServiceEnvironmentStatus } from '../login-shell-environment';
/**
 * Issue #392: `byok-agent start --service` runs under a service manager's
 * minimal environment. {@link applyLoginShellEnvironment} replaces this
 * process's `process.env` with the login-shell snapshot
 * (`../login-shell-environment.ts`, the base of every runtime environment)
 * and puts back the `BYOK_*` values this process had, so that the daemon
 * resolves its own config and binaries as the user's terminal would.
 */
/** The `byok-agent start` flag generated service definitions pass. */
export declare const SERVICE_FLAG = "--service";
/**
 * Replaces `process.env` with this process's login-shell snapshot, keeping
 * this process's own `BYOK_*` values. Runs once per process: later calls
 * return the first call's result. On failure `process.env` is left exactly as
 * inherited. Never throws.
 */
export declare function applyLoginShellEnvironment(): Promise<ServiceEnvironmentStatus>;
/**
 * {@link captureLoginShellSnapshot} followed by the replacement
 * {@link applyLoginShellEnvironment} makes, on `options.env`.
 *
 * @internal
 */
export declare function captureAndApply(options: ApplyLoginShellEnvironmentOptions): Promise<ServiceEnvironmentStatus>;
// ==== @byok-sdk/client dist/lifecycle/service-installation.d.ts ====
import type { StoreCompatibility } from '@byok-sdk/core';
import { type CreateServiceLifecycleOptions } from './create-service-lifecycle';
import type { ManagedServiceLifecycle } from './managed-lifecycle';
import type { ServiceDefinition, ServiceInstallOptions, ServiceLifecycle, ServiceProgram } from './service-types';
/** The manifest every payload directory carries at its root. */
export declare const SERVICE_PAYLOAD_MANIFEST = "byok-payload.json";
/**
 * A payload's manifest (#1097). The Host verifies the payload's signature
 * before handing it to the SDK; the SDK checks every file against `files`
 * and accepts no file the manifest does not list.
 */
export interface ServicePayloadManifest {
    format: 'byok-service-payload';
    version: 1;
    /** The version id: 1-64 of `A-Z a-z 0-9 . _ -`, starting with a letter or digit. Becomes `versions/<id>`. */
    id: string;
    /** Every file of the payload except the manifest: `/`-separated relative path → lowercase hex SHA-256. */
    files: Record<string, string>;
}
/**
 * What an installation is told to do (#1097). `program` and `precheck`
 * receive a version directory: `program` gets `<installRoot>/current`, so the
 * unit and launcher never change across upgrades; `precheck` gets the staged
 * candidate's own directory.
 */
export interface ServiceInstallationOptions {
    /** The service, without `program`: {@link ServiceInstallationOptions.program} supplies it. */
    service: Omit<ServiceDefinition, 'program'>;
    /** The daemon's product id; the default health check reaches its control socket with it. */
    productId: string;
    /**
     * A Host-owned directory outside the store. The SDK owns `versions/`,
     * `current`, `previous`, `snapshots/` and `upgrade-receipt.json` in it.
     */
    installRoot: string;
    /** The service program, run from `versionDir`. */
    program(versionDir: string): ServiceProgram;
    /**
     * The candidate's store precheck, run from its staged `versionDir` while
     * every writer is stopped. It prints `{ "stores": StoreCompatibility[] }`
     * (what `byok-agent upgrade check --store --json` prints) and exits 0 or 2.
     * Every store the candidate rewrites must be listed: the snapshot covers
     * exactly the listed stores.
     */
    precheck(versionDir: string): ServiceProgram;
    /**
     * Resolves when the started version is healthy and throws when it is not.
     * Default: the daemon's control socket reports a live `lifecycle` — `running`
     * (connecting or open), or `awaiting-enrollment` for a service-enrollment
     * daemon that has not paired yet. `halted` or `crashed` fails at once.
     */
    healthCheck?(signal: AbortSignal): Promise<void>;
    /** How long the health check may take. Default 60000. */
    healthTimeoutMs?: number;
    /** How long a stop may take to leave the store quiescent. Default 30000. */
    stopTimeoutMs?: number;
    /** Test seams for the underlying lifecycle. */
    lifecycle?: CreateServiceLifecycleOptions;
}
/**
 * The upgrade receipt a Host UI reads (`upgrade-receipt.json`):
 *
 * - `pending`: an upgrade or a rollback began and has not been confirmed.
 *   It is written before the service is stopped, so it also covers a death
 *   before the snapshot: `recover()` then starts `from` again without a
 *   store restore. Only `recover()` resolves a pending receipt, by
 *   restoring `from` with the snapshot taken for `to` when one exists. A
 *   rollback journals its target as `from`, so recover completes it.
 * - `switched`: `to` runs and passed the health check.
 * - `rolled-back`: `from` runs again with its store snapshot; `code` says why.
 * - `failed`: nothing was switched (`code` and, for a store refusal,
 *   `stores` say why), or a rollback could not bring `from` back to health.
 */
export interface ServiceUpgradeReceipt {
    format: 'byok-service-upgrade-receipt';
    version: 1;
    state: 'pending' | 'switched' | 'rolled-back' | 'failed';
    from: string;
    to: string;
    /** Where `previous` pointed before this upgrade; a restore of `from` puts it back, so an earlier upgrade can still be rolled back. */
    previous?: string;
    at: string;
    code?: ServiceInstallationErrorCode;
    stores?: StoreCompatibility[];
}
/**
 * Every mutation (install, upgrade, rollback, recover, uninstall) first
 * passes the lifecycle's owner check: when another owner is recorded for the
 * store it throws `ServiceUnitError` `lifecycle_owner_conflict` and changes
 * nothing.
 */
export interface ServiceInstallation {
    /** The service lifecycle whose program runs `<installRoot>/current`. */
    readonly lifecycle: ServiceLifecycle;
    /** Stages the payload as the first version, points `current` at it, installs and starts the service. */
    install(payloadDir: string, opts?: ServiceInstallOptions): Promise<void>;
    /**
     * Stages the payload, writes the pending receipt, stops the service, runs
     * the candidate's precheck, snapshots the listed stores, switches
     * `current` (the old one becomes `previous`), starts it and checks its
     * health. A store refusal stops before the switch and restarts the old
     * version; a failed health check restores the old version and its snapshot
     * together; a death after the receipt leaves `recover()` that work.
     */
    upgrade(payloadDir: string): Promise<ServiceUpgradeReceipt>;
    /**
     * Restores `previous` and the store snapshot taken when `current` was
     * switched to, under a `pending` receipt written first. Store writes since
     * that switch are discarded.
     */
    rollback(): Promise<ServiceUpgradeReceipt>;
    /** Resolves a `pending` receipt by restoring its `from` version and snapshot. Returns the receipt, or `undefined` when there is none. */
    recover(): Promise<ServiceUpgradeReceipt | undefined>;
    /** Uninstalls the service and removes `versions/`, the pointers, `snapshots/` and the receipt. The store is not touched. */
    uninstall(): Promise<void>;
    /** The last receipt, or `undefined`. */
    receipt(): Promise<ServiceUpgradeReceipt | undefined>;
    /** The version `current` points at, or `undefined` before install. */
    currentVersion(): Promise<string | undefined>;
}
declare const ERROR_MESSAGES: {
    readonly installation_absent: 'No version is installed under this install root. Install a payload first.';
    readonly installation_exists: 'A version is already installed under this install root. Upgrade it instead.';
    readonly payload_invalid: 'The payload manifest is missing, malformed, or does not match the payload files.';
    readonly version_current: 'The payload is the version already running.';
    readonly version_conflict: 'A different payload with the same version id is already staged.';
    readonly upgrade_pending: 'An earlier upgrade or rollback was interrupted. Run recover() (CLI: byok-agent upgrade recover) first.';
    readonly store_busy: 'The store still has a running owner after the stop. Stop every process that uses this store and retry.';
    readonly owned_process_residue: 'Processes from the previous daemon run survived; resolve them before upgrading.';
    readonly precheck_failed: 'The candidate\'s store precheck did not produce a verdict.';
    readonly store_repair_required: 'The candidate needs a new store path and a new pairing. Nothing was switched; decide before upgrading.';
    readonly store_rejected: 'The candidate refuses a store. Nothing was switched; resolve the store first.';
    readonly health_check_failed: 'The new version failed its health check; the previous version and its store snapshot were restored.';
    readonly rollback_unhealthy: 'The previous version was restored but failed its health check too.';
    readonly no_rollback: 'There is no previous version with a store snapshot to roll back to.';
};
export type ServiceInstallationErrorCode = keyof typeof ERROR_MESSAGES;
/** Closed codes; a store refusal carries the precheck verdicts. */
export declare class ServiceInstallationError extends Error {
    readonly code: ServiceInstallationErrorCode;
    readonly stores?: readonly StoreCompatibility[] | undefined;
    constructor(code: ServiceInstallationErrorCode, stores?: readonly StoreCompatibility[] | undefined);
}
/** `<storeDir>/service/installation.json`: where this store's installation lives. */
export interface ServiceInstallationRecord {
    format: 'byok-service-installation';
    version: 1;
    installRoot: string;
}
export declare function serviceInstallationRecordPath(storeDir: string): string;
/** The installation record of a store, or `undefined` when the service is not installed from payloads. */
export declare function readServiceInstallationRecord(storeDir: string): Promise<ServiceInstallationRecord | undefined>;
/**
 * @internal The running version and the last receipt of an install root,
 * read from disk only: no service definition, unit or service manager is
 * involved, so a status read needs none of their inputs (WinSW paths).
 */
export declare function readServiceInstallationState(installRoot: string): Promise<{
    current: string | undefined;
    receipt: ServiceUpgradeReceipt | undefined;
}>;
export declare function createServiceInstallation(opts: ServiceInstallationOptions): ServiceInstallation;
/**
 * The default health check: polls the daemon's control socket until its own
 * lifecycle reports a live run ({@link daemonLifecycleHealth}). A
 * service-enrollment daemon that has not paired yet is up, not a failed
 * upgrade, so `awaiting-enrollment` is healthy; a halted or crashed run fails
 * at once (#1097).
 */
export declare function defaultServiceHealthCheck(options: {
    storeDir: string;
    productId: string;
}): (signal: AbortSignal) => Promise<void>;
/**
 * @internal The installation over a given lifecycle; tests drive it with a
 * fake service manager. Every mutation runs inside `lifecycle.owned()`, so
 * another recorded lifecycle owner is refused before anything is written.
 */
export declare function serviceInstallationOver(opts: ServiceInstallationOptions, lifecycle: ManagedServiceLifecycle): ServiceInstallation;
export declare function readPayloadManifest(payloadDir: string): Promise<ServicePayloadManifest>;
export {};
// ==== @byok-sdk/client dist/lifecycle/service-log.d.ts ====
/**
 * The daemon log `byok-agent start --service` writes itself (#1097): its
 * record lines and diagnostics. Rotated by size; `maxFiles` counts the
 * active file and its rotated copies (`daemon.log.1` is the newest copy).
 */
export declare const DAEMON_LOG_FILENAME = "daemon.log";
export declare const DAEMON_LOG_LIMITS: Readonly<{
    maxBytes: number;
    maxFiles: 5;
}>;
/**
 * The service manager's stdout/stderr redirect (launchd `StandardOutPath`,
 * systemd `append:`). Once {@link routeProcessOutputToDaemonLog} runs only a
 * fatal error Node writes to fd 2 itself still lands there, and each service
 * start rotates a file over this size to one `.1` copy. WinSW rolls its own redirect by the same limit
 * (`roll-by-size`).
 */
export declare const SERVICE_REDIRECT_STDOUT_FILENAME = "service-stdout.log";
export declare const SERVICE_REDIRECT_STDERR_FILENAME = "service-stderr.log";
export declare const SERVICE_REDIRECT_LIMITS: Readonly<{
    maxBytes: number;
    maxFiles: 2;
}>;
export interface DaemonLogOptions {
    /** `resolveHostLayout(...).logDir`; created if missing. */
    logDir: string;
    maxBytes?: number;
    maxFiles?: number;
}
export interface DaemonLog {
    /** The active file. */
    readonly path: string;
    /** Appends one line (a trailing newline is added). Rotates first when the line would cross `maxBytes`. */
    write(line: string): void;
    close(): void;
}
/**
 * Opens the daemon log in `logDir`. Writes are synchronous so lines keep
 * their order and survive a crash right after them. A single line longer
 * than `maxBytes` is still written whole, into a fresh file.
 */
export declare function openDaemonLog(options: DaemonLogOptions): DaemonLog;
/**
 * Routes everything this process writes to `process.stdout` and
 * `process.stderr` (every `console.*` call included) into the daemon log
 * until `close()`, so no runtime path can grow the service manager's
 * redirect while the daemon runs (#1097). Only output Node writes to fd 2
 * itself, such as a fatal error, still reaches the redirect, once per
 * process; {@link boundServiceRedirectLogs} bounds it at the next start.
 * Child processes are spawned with piped stdio and never share fd 1 or 2.
 */
export declare function routeProcessOutputToDaemonLog(options: DaemonLogOptions): {
    readonly path: string;
    close(): void;
};
/**
 * Bounds the service manager's redirect files at service start: each file
 * over {@link SERVICE_REDIRECT_LIMITS}.maxBytes becomes its single `.1` copy.
 * The manager reopens the path on the next spawn.
 */
export declare function boundServiceRedirectLogs(logDir: string): void;
export interface ServiceLogReport {
    /** The inspected log directory. */
    dir: string;
    status: 'present' | 'missing' | 'unavailable';
    totalBytes: number;
    /** `daemon`: the daemon log and its rotated copies. `service-manager`: the launchd/systemd/WinSW redirect files. */
    files: Array<{
        name: string;
        kind: 'daemon' | 'service-manager';
        sizeBytes: number;
    }>;
    truncated: boolean;
}
/** Location and size of every regular file in `logDir` (#1097: `status` and `doctor` report them). Read-only. */
export declare function inspectServiceLogs(logDir: string): Promise<ServiceLogReport>;
// ==== @byok-sdk/client dist/lifecycle/service-types.d.ts ====
import type { ServiceLogReport } from './service-log';
import type { ServiceRepairResult, ServiceUnitInspection } from './service-unit';
/**
 * What the stable launcher executes (#1097). The unit never names it: on
 * macOS and Linux the unit runs `<storeDir>/service/<name>.launcher.sh`,
 * which execs this program; on Windows the SCM runs the installed WinSW
 * executable, whose descriptor names it. Changing the program rewrites the
 * launcher, never the unit's own path or arguments.
 *
 * `command` should be absolute: a bare name resolves against the service
 * manager's minimal PATH, which rarely includes nvm/volta/homebrew Node.
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
     *
     * The lifecycles never add or change an argument: a Host's own binary
     * gets exactly these. Issues #392/#394: `byok-agent install` builds its
     * program with {@link NodeAgentProgramOptions.service} on every platform.
     */
    args: string[];
    /** Working directory for the running service process; the launcher `cd`s into it. Default: the user's home (macOS, Linux), the WinSW install directory (Windows). */
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
    /**
     * Append {@link SERVICE_FLAG}: `byok-agent start` then replaces the service
     * manager's minimal environment with the user's login-shell environment
     * (issue #392, `service-environment.ts`; win32 has none) and exits 0 on a
     * halt, so the supervisor does not restart it (issue #394). For a program
     * a service manager will run; `byok-agent install` sets it on every
     * platform.
     */
    service?: boolean;
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
    /** What the launcher runs — see {@link ServiceProgram}. */
    program: ServiceProgram;
    /** The product's SDK store (`DaemonConfig.storeDir` or its default). Holds the launcher and the lifecycle owner record under `<storeDir>/service`. */
    storeDir: string;
    /** `resolveHostLayout(...).logDir`: the daemon log and the service manager's redirect files (created if missing). On Windows also the default WinSW install directory — see `windows.installDir`. */
    logDir: string;
    /**
     * The lifecycle owner, e.g. `cli` or `app` (1-32 of `a-z`, `0-9`, `-`).
     * One owner per product store sets autostart; another owner's `install`,
     * `repair` and `uninstall` throw `ServiceUnitError` `lifecycle_owner_conflict`.
     */
    owner: string;
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
/** Options for {@link ServiceLifecycle.install}. */
export interface ServiceInstallOptions {
    /** Replace a `foreign` unit (one without the SDK marker) at the unit path. Explicit operator intent only; never a default. */
    replaceUnmarked?: boolean;
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
    /** How the installed unit compares with this definition's (#1097). */
    unit: ServiceUnitInspection;
    /** Location and size of the daemon log and the redirect files. */
    logs: ServiceLogReport;
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
 * `KeepAlive`, systemd `Restart=always` + `RestartPreventExitStatus=0`,
 * WinSW `<onfailure>`) under the exit-code contract in `exit-codes.ts` — no
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
    /**
     * Writes the unit and launcher, claims the lifecycle owner record and
     * registers + starts the service. Safe to call again: rewrites both and
     * reloads. Throws `ServiceUnitError` `service_unit_unmarked` for a
     * `foreign` unit unless `replaceUnmarked` is set.
     */
    install(opts?: ServiceInstallOptions): Promise<void>;
    /** Rewrites and reloads a `repairable` unit; `exact` and `absent` are `not-needed`. Throws `service_unit_unmarked` for a `foreign` unit, which it never changes. */
    repair(): Promise<ServiceRepairResult>;
    /** Classifies the installed unit: absent / exact / repairable / foreign. Read-only. */
    inspect(): Promise<ServiceUnitInspection>;
    /** Stops (if running) and fully removes the service registration, unit, launcher and owner record. Safe to call when not installed; refuses a `foreign` unit. Throws — and leaves the control file in place — if the underlying service manager reports a genuine failure rather than success/"not installed"; see this interface's own doc comment. */
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
// ==== @byok-sdk/client dist/lifecycle/service-unit.d.ts ====
import { promises as fsp } from 'node:fs';
import type { ServiceProgram } from './service-types';
/**
 * Every unit this SDK generates carries this text (an XML comment in a
 * plist or WinSW descriptor, a `#` comment in a systemd unit). It is the
 * only ownership evidence `inspect()` accepts: a file at our unit path
 * without it is `foreign` and never changed, unless the operator passes
 * `install({ replaceUnmarked: true })`.
 */
export declare const SERVICE_UNIT_MARKER = "byok-sdk-service-unit: generated by @byok-sdk/client; repair() reverts local edits";
/**
 * How an installed unit compares with the one this definition generates (#1097):
 *
 * - `absent`: no unit file at the unit path.
 * - `exact`: the unit and its launcher match byte for byte.
 * - `repairable`: the unit carries {@link SERVICE_UNIT_MARKER} but it, or
 *   its launcher, differs. `repair()` and `install()` rewrite both.
 * - `foreign`: a unit file without the marker. Nothing changes it.
 */
export type ServiceUnitState = 'absent' | 'exact' | 'repairable' | 'foreign';
export interface ServiceUnitInspection {
    state: ServiceUnitState;
    /** The plist, systemd unit or WinSW descriptor. */
    unitPath: string;
    /** The stable launcher the unit runs (macOS and Linux); on Windows the SCM runs the installed WinSW executable. */
    launcherPath: string;
    /** The lifecycle owner recorded in the store, when one is. */
    owner?: string;
}
export type ServiceRepairResult = {
    status: 'repaired';
} | {
    status: 'not-needed';
    state: 'exact' | 'absent';
};
declare const ERROR_MESSAGES: {
    readonly service_unit_unmarked: 'A service unit this SDK did not generate exists at the unit path. Re-run install with replaceUnmarked (CLI: --replace-unmarked) to replace it, or remove it with the tool that installed it.';
    readonly lifecycle_owner_conflict: 'Another lifecycle owner of this product manages autostart. Uninstall through that owner first.';
    readonly lifecycle_owner_unreadable: 'The lifecycle owner record in the store cannot be read; preserve it for inspection.';
    readonly lifecycle_owner_busy: 'Another service lifecycle operation or local-state relocation is in progress. Run it again when that one has finished.';
    readonly invalid_owner: 'The lifecycle owner must be 1-32 characters: lowercase letters, digits and "-", starting with a letter or digit.';
    readonly service_unload_timeout: 'The service manager did not finish unloading the stopped service in time. Check the service manager, then run the operation again.';
};
export type ServiceUnitErrorCode = keyof typeof ERROR_MESSAGES;
/** Closed codes only; the message never carries a path or OS text. */
export declare class ServiceUnitError extends Error {
    readonly code: ServiceUnitErrorCode;
    constructor(code: ServiceUnitErrorCode);
}
export declare function assertServiceOwner(owner: unknown): asserts owner is string;
/** `<storeDir>/service`: the SDK-owned directory for the launcher and the lifecycle owner record. */
export declare function serviceStateDir(storeDir: string, platform?: NodeJS.Platform): string;
/** The stable launcher path a macOS or Linux unit runs. */
export declare function serviceLauncherPath(storeDir: string, serviceName: string, platform?: NodeJS.Platform): string;
/**
 * The POSIX launcher every macOS and Linux unit runs. The unit names only
 * this file, so a new program (a moved binary, a new Node, a new `current`)
 * rewrites the launcher and never the unit. It sets no environment:
 * `byok-agent start --service` captures the login-shell environment at
 * start (#392).
 */
export declare function generateServiceLauncher(program: ServiceProgram): string;
export interface ServiceUnitFile {
    path: string;
    content: string;
    mode?: number;
}
export type ServiceUnitFs = Pick<typeof fsp, 'readFile'>;
/** Compares the installed files with `expected`; `expected[0]` is the unit. */
export declare function classifyServiceUnit(fs: ServiceUnitFs, expected: readonly ServiceUnitFile[]): Promise<ServiceUnitState>;
export interface ServiceLifecycleOwnerInput {
    storeDir: string;
    /** Who sets autostart for this product, e.g. `cli` or `app`. */
    owner: string;
    /** The service name the owner registers. */
    service: string;
}
export type ServiceOwnerFs = Pick<typeof fsp, 'readFile' | 'writeFile' | 'rename' | 'rm' | 'mkdir'>;
/**
 * The lifecycle owner recorded for this product's store (#1097): the one
 * party (the CLI, or the product's App) that sets autostart. Undefined when
 * no owner holds it.
 */
export declare function readServiceLifecycleOwner(storeDir: string, fs?: ServiceOwnerFs): Promise<{
    owner: string;
    service: string;
} | undefined>;
/**
 * Runs `operation` holding the cross-process `service-lifecycle` mutation
 * gate (`util/path-mutation-gate.ts`): one per user, with no target path,
 * like the per-user namespace of the service manager it guards. Every
 * owner-record mutation reads, compares and writes inside one hold, so a
 * remove or replace acts on the record this process read and never on a
 * successor's. It is never the `store` gate: a managed install holds this one
 * while it waits for the daemon it starts, and that daemon takes `store`.
 * Local-state relocation takes this gate before `store`, so the order is
 * always `service-lifecycle` then `store`. A held gate fails at once with
 * `lifecycle_owner_busy`; the gate frees itself when its holder process exits.
 *
 * @internal
 */
export declare function withServiceOwnerGate<T>(operation: () => Promise<T>): Promise<T>;
/**
 * Records `owner` as the product's lifecycle owner. Idempotent for the same
 * owner; throws `lifecycle_owner_conflict` when another owner holds it and
 * `lifecycle_owner_busy` while another service lifecycle operation or a
 * local-state relocation is in progress. An App that sets autostart through its own mechanism (a login
 * item) claims here too, so the CLI's `install` refuses instead of adding a
 * second one.
 */
export declare function claimServiceLifecycleOwner(input: ServiceLifecycleOwnerInput, fs?: ServiceOwnerFs): Promise<void>;
/**
 * {@link claimServiceLifecycleOwner} for a caller already inside
 * {@link withServiceOwnerGate}.
 *
 * @internal
 */
export declare function claimHeldServiceLifecycleOwner(input: ServiceLifecycleOwnerInput, fs: ServiceOwnerFs): Promise<void>;
/**
 * Removes the owner record when `owner` holds it; throws
 * `lifecycle_owner_conflict` when another owner does and `lifecycle_owner_busy`
 * while another service lifecycle operation or a local-state relocation is in
 * progress.
 */
export declare function releaseServiceLifecycleOwner(input: Omit<ServiceLifecycleOwnerInput, 'service'>, fs?: ServiceOwnerFs): Promise<void>;
/**
 * {@link releaseServiceLifecycleOwner} for a caller already inside
 * {@link withServiceOwnerGate}.
 *
 * @internal
 */
export declare function releaseHeldServiceLifecycleOwner(input: Omit<ServiceLifecycleOwnerInput, 'service'>, fs: ServiceOwnerFs): Promise<void>;
export {};
// ==== @byok-sdk/client dist/lifecycle/systemd.d.ts ====
import { type Runner } from '../util/exec-runner';
import { type ManagedLifecycleFs, type ManagedServiceLifecycle } from './managed-lifecycle';
import { type ServiceDefinition } from './service-types';
/** DI seam for tests — see `exec-runner.ts`'s `Runner` doc comment. */
export interface SystemdDeps {
    run?: Runner;
    fs?: ManagedLifecycleFs;
    homedir?: () => string;
}
/**
 * Generates a systemd user unit for `name` that runs only the stable
 * `launcherPath` (#1097), logging to `logDir`. Pure/no I/O — unit-tested
 * directly for exact content shape, and (locally, when `systemd-analyze` is
 * available) verified with `systemd-analyze verify` — see
 * `templates/service/systemd/README.md`.
 *
 * `Restart=always` + `RestartPreventExitStatus=0` + `RestartSec=10` is the
 * exit-code contract in `exit-codes.ts`: any exit but 0 restarts.
 * `StandardOutput`/`StandardError` append to redirect files under `logDir`
 * that receive only early-boot crash output; the daemon writes its own
 * rotated log (`service-log.ts`). The journal (`journalctl --user -u
 * <name>`) still records the unit's output alongside.
 */
export declare function generateSystemdUnit(def: {
    name: string;
    displayName: string;
    launcherPath: string;
    workingDirectory: string;
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
export declare function createSystemdLifecycle(def: ServiceDefinition, deps?: SystemdDeps): ManagedServiceLifecycle;
// ==== @byok-sdk/client dist/lifecycle/winsw.d.ts ====
import { promises as fsp } from 'node:fs';
import { type Runner } from '../util/exec-runner';
import { type ManagedLifecycleFs, type ManagedServiceLifecycle } from './managed-lifecycle';
import { type ServiceDefinition, type ServiceProgram } from './service-types';
/** DI seam for tests — see `exec-runner.ts`'s `Runner` doc comment. */
export interface WinswDeps {
    run?: Runner;
    fs?: ManagedLifecycleFs & Pick<typeof fsp, 'copyFile'>;
}
/**
 * Generates a WinSW (https://github.com/winsw/winsw) service descriptor XML
 * for `id` running `program`, logging to `logDir`. Pure/no I/O — unit-tested
 * directly for exact content shape; the REAL proof this is valid WinSW XML
 * is the `windows-service-smoke` CI job (`.github/workflows/ci.yml`), which
 * actually runs `winsw install` against generated output on a real
 * `windows-latest` runner — this macOS dev box cannot execute WinSW at all.
 *
 * On Windows the SCM registration is the unit and names only the stable
 * `<id>.exe` (#1097); this descriptor, which WinSW reads at every start, is
 * the launcher. The {@link SERVICE_UNIT_MARKER} comment marks it as ours.
 *
 * Each argument becomes its own `<argument>` element (WinSW's supported
 * repeatable-element form) rather than a single space-joined `<arguments>`
 * string — this sidesteps shell-style quoting entirely for a config path
 * containing spaces (WinSW launches `<executable>` directly, no shell
 * involved).
 *
 * `<onfailure action="restart">` fires on a non-zero exit only: the
 * exit-code contract in `exit-codes.ts`. `<log mode="roll-by-size">` bounds
 * WinSW's stdout/stderr redirect the same way the daemon's start bounds the
 * launchd/systemd one (`SERVICE_REDIRECT_LIMITS`).
 * `<startmode>Automatic</startmode>` mirrors launchd's `RunAtLoad`/systemd's
 * `WantedBy=default.target`.
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
 * it in place.
 *
 * `status()` queries `sc.exe` (the real Windows SCM query tool, always
 * present) rather than parsing WinSW's own `status` subcommand text.
 */
export declare function createWinswLifecycle(def: ServiceDefinition, deps?: WinswDeps): ManagedServiceLifecycle;
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
// ==== @byok-sdk/client dist/login-shell-environment.d.ts ====
/**
 * Issue #392 (parent #384 item 2): a daemon started by launchd or systemd
 * gets the service manager's minimal environment (launchd's default PATH is
 * `/usr/bin:/bin:/usr/sbin:/sbin`), not the user's. ADR-037 D2 lets every
 * runtime inherit the daemon's environment, which assumes the daemon's
 * environment IS the user's — so under a service, `claude`/`codex` installed
 * by Homebrew, nvm, bun or an official installer are `not-found`, and
 * rc-only settings (proxies, `ANTHROPIC_BASE_URL`, `CODEX_HOME`, ...) are
 * missing.
 *
 * #1095: this capture is also the base of every runtime environment
 * (`runtime/environment.ts`). {@link loginShellSnapshot} runs the account's
 * login shell once per process as
 * `<shell> -i -l -c 'printf %s B; /usr/bin/env -0; printf %s E'`, with B and
 * E random per-run nonces, and keeps the NUL-separated entries found between
 * them. Bytes outside the frame — rc chatter on stdout — are ignored. The
 * capture is complete once the shell has exited and the end nonce has been
 * read; a background job the rc started may keep stdout open, so the capture
 * never waits for EOF after that. Caps: {@link LOGIN_SHELL_ENV_TIMEOUT_MS} and
 * {@link LOGIN_SHELL_ENV_MAX_BYTES}. However the capture ends, the shell's
 * whole process group is SIGKILLed.
 *
 * The shell is read from the account database by uid, never from `$SHELL`
 * (Bun's `os.userInfo().shell` returns `$SHELL`, so a Host variable would
 * choose the shell): `/usr/bin/id -P <uid>` on darwin (Open Directory),
 * `/usr/bin/getent passwd <uid>` on linux (NSS). The entry's uid field must be
 * this process's uid and its last field an absolute path; anything else,
 * including another platform, fails closed as `account-shell-unavailable`.
 *
 * The shell does not start from this process's environment: an embedding
 * Host's own variables would come back out of `env -0`. It starts from
 * {@link LOGIN_SHELL_SEED_NAMES} copied from this process, `PATH` set to
 * {@link LOGIN_SHELL_SEED_PATH} and `SHELL` set to the account shell, what
 * launchd and login(1) give a session;
 * everything else in the snapshot is what the user's rc files produced.
 * `BYOK_*` names found in the capture are dropped: rc files never set SDK
 * control variables. The snapshot never changes `process.env`.
 *
 * `byok-agent start --service` additionally replaces `process.env` with the
 * snapshot (`lifecycle/service-environment.ts`). win32 has no login shell:
 * the snapshot source is `windows-session`, and the runtime environment takes
 * its baseline names from the live session environment.
 *
 * Every report of the result — `start` stdout, `audit.jsonl`, `status` —
 * carries only {@link ServiceEnvironmentStatus}: a source, a closed code,
 * the shell's basename and a duration. Never a variable name, value or path.
 */
export declare const LOGIN_SHELL_ENV_TIMEOUT_MS = 10000;
export declare const LOGIN_SHELL_ENV_MAX_BYTES: number;
/**
 * The names the login shell starts with, copied from this process: the
 * account and locale, where the shell finds its rc files (`ZDOTDIR`,
 * `XDG_*`), and the session sockets a login manager sets and no rc sets.
 * Every other variable of this process stays out of the capture.
 */
export declare const LOGIN_SHELL_SEED_NAMES: readonly string[];
/** The login shell's starting `PATH`; `/etc/zprofile` (path_helper) and `/etc/profile` build the rest. */
export declare const LOGIN_SHELL_SEED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
export declare const SERVICE_ENVIRONMENT_UNAVAILABLE_CODES: readonly ['account-shell-unavailable', 'unsupported-shell', 'spawn-failed', 'timeout', 'output-too-large', 'bad-frame', 'shell-exit-nonzero'];
export type ServiceEnvironmentUnavailableCode = (typeof SERVICE_ENVIRONMENT_UNAVAILABLE_CODES)[number];
/**
 * Where the runtime environment base came from. `inherited`: no snapshot has
 * been taken in this process yet. `windows-session`: win32, which has no login
 * shell.
 */
export type ServiceEnvironmentStatus = {
    source: 'login-shell';
    shell: string;
    durationMs: number;
} | {
    source: 'inherited';
} | {
    source: 'windows-session';
} | {
    source: 'unavailable';
    code: ServiceEnvironmentUnavailableCode;
};
/** One process's login-shell capture. `env` is present exactly when `status.source` is `login-shell`. */
export interface LoginShellSnapshot {
    readonly status: ServiceEnvironmentStatus;
    readonly env?: Readonly<Record<string, string | undefined>>;
}
/** Timestamped closed environment observation shared by diagnostics and audit. */
export interface ServiceEnvironmentRecord {
    status: ServiceEnvironmentStatus;
    ts: string;
}
/**
 * Test seams for {@link captureLoginShellSnapshot} and `captureAndApply`.
 * Not part of the public API.
 *
 * @internal
 */
export interface ApplyLoginShellEnvironmentOptions {
    /** Test seam: an absolute shell path instead of the account shell, past the supported-shell gate. */
    shell?: string;
    /** Test seam: the account-database command (absolute path, then arguments) instead of the platform's. */
    accountCommand?: readonly [string, ...string[]];
    /** Test seam: the environment the seed is copied from (and, for `captureAndApply`, the one replaced). Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxBytes?: number;
    platform?: NodeJS.Platform;
}
/** Where this process's runtime environment base came from; `inherited` until {@link loginShellSnapshot} has resolved. */
export declare function serviceEnvironmentStatus(): ServiceEnvironmentStatus;
/**
 * This process's login-shell snapshot, captured on the first call. Later
 * calls return the first call's result. Never throws.
 */
export declare function loginShellSnapshot(): Promise<LoginShellSnapshot>;
/**
 * Test seam: replaces how {@link loginShellSnapshot} obtains the snapshot and
 * forgets an earlier one; `undefined` restores the real capture.
 *
 * @internal
 */
export declare function setLoginShellSnapshotSource(source: (() => Promise<LoginShellSnapshot>) | undefined): void;
/**
 * Takes one snapshot without the once-per-process latch.
 *
 * @internal
 */
export declare function captureLoginShellSnapshot(options: ApplyLoginShellEnvironmentOptions): Promise<LoginShellSnapshot>;
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
// ==== @byok-sdk/client dist/mcp-server/http.d.ts ====
import { type McpServerOptions } from './index';
/** Maximum accepted HTTP request body, in UTF-8 bytes. */
export declare const MCP_HTTP_MAX_BODY_BYTES: number;
export interface McpHttpServerOptions extends Omit<McpServerOptions, 'input' | 'output' | 'onClose' | 'maxLineBytes'> {
    /** Stateful by default. Stateless mode retains no sessions and disallows SSE. */
    readonly sessionMode?: 'stateful' | 'stateless';
    /** Trusted public origin, e.g. https://host.example. Never derive it from the request Host header. */
    readonly origin: string;
    /** Additional exact Origin values from trusted Host configuration, validated like `origin`. Default none. */
    readonly allowedOrigins?: readonly string[];
    /** Positive integer, at most MCP_HTTP_MAX_BODY_BYTES. */
    readonly maxBodyBytes?: number;
    /** Bounds idle sessions as well as emitter subscriptions. Default 64. Applies only in stateful mode. */
    readonly maxSessions?: number;
    /** Idle lifetime without pending core replies. SSE alone does not keep a session alive. Default 15 minutes. Applies only in stateful mode. */
    readonly idleTimeoutMs?: number;
}
export interface McpHttpServer {
    /** Mount at one MCP endpoint after Host authentication. Each authenticated caller owns a separate instance. */
    fetch(request: Request): Promise<Response>;
    /** Abort calls, close SSE streams and release all session resources. Idempotent. */
    close(): void;
}
/**
 * Streamable HTTP framing for the existing bounded MCP core. No tool semantics,
 * listener, auth or caller ledger. The Host owns routing, TLS and authentication.
 * Sessions are scoped to this instance; never share it between authenticated callers.
 */
export declare function createMcpHttpServer(options: McpHttpServerOptions): McpHttpServer;
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
    readonly title?: string;
    readonly annotations?: Readonly<{
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    }>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
    /** Caller-supplied, passed through verbatim. The core never authors, validates against, or rewrites it. */
    readonly inputSchema: Readonly<Record<string, unknown>>;
    /** Caller-owned MCP metadata, passed through verbatim with the tool definition. */
    readonly _meta?: Readonly<Record<string, unknown>>;
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
    /** Report increasing finite progress. No-op without a token or after cancellation/completion. */
    readonly progress: (progress: number, total?: number, message?: string) => void;
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
/**
 * Accepting another output frame would exceed 4 MiB or 256 pending frames,
 * including unfinished stream writes. Reading stops, calls abort and queued
 * replies are discarded. Already-submitted stream writes may still finish.
 */
 | {
    readonly kind: 'outbound-buffer-limit';
    readonly limitBytes: number;
    readonly limitFrames: number;
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
 * the pinned `@modelcontextprotocol/client`. Only the process layer is ours, and
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
     * (`RuntimeAdapter.runtimeEnvironment`) — never `process.env`. Required, deliberately: a
     * caller that forgets it fails to compile rather than passing this SDK's
     * own `BYOK_*` control-plane variables.
     */
    readonly env: Readonly<Record<string, string>>;
    /** Working directory for the child — the same one the runtime CLI is spawned in. */
    readonly cwd?: string;
    /** Per-request deadline. */
    readonly timeoutMs?: number;
    /** Opt-in lifetime stdout cap; see {@link MCP_OBSERVATION_MAX_STDOUT_BYTES}. */
    readonly maxStdoutBytes?: number;
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
    private deadline;
    constructor(server: McpStdioServerSpec, options: McpStdioClientOptions);
    /**
     * Start the child and complete `initialize`.
     *
     * Optional `deadline` is an absolute same-process `performance.now()` value
     * in milliseconds. It must be finite; expired values refuse the spawn. It
     * guards spawn and every outgoing frame; the signal still cancels protocol
     * waits. Per-request timeouts remain unchanged. Observations supply both;
     * long-lived call clients normally omit the absolute deadline.
     */
    connect(signal?: AbortSignal, deadline?: number): Promise<void>;
    private checkDeadline;
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
// ==== @byok-sdk/client dist/mcp/event-identity.d.ts ====
import type { AgentEvent } from '@byok-sdk/protocol';
import type { McpToolsetToolObservation } from '../types';
export type McpEventIdentity = NonNullable<Extract<AgentEvent, {
    type: 'tool_use';
}>['mcp']>;
export type McpEventIdentities = ReadonlyMap<string, McpEventIdentity>;
/** Exact admitted names, never split an arbitrary runtime label (names may contain __). */
export declare function mcpEventIdentities(observation?: McpToolsetToolObservation): McpEventIdentities;
// ==== @byok-sdk/client dist/mcp/observation.d.ts ====
import { type McpStdioClientOptions, type McpStdioServerSpec } from './client';
/**
 * Tool names an adapter registers must be OBSERVED, never configured: the
 * daemon's own `mcpToolsets` config carries `command`/`args` only (see
 * `../daemon/toolset-registry.ts`), so the single authority for "which tools
 * does this server actually expose" is the server's own `tools/list` answer.
 *
 * A name that survives this filter becomes a runtime tool name — the
 * registered Pi tool name and the qualified `mcp__<server>__<tool>` name. A
 * comma, a dot, a quote, or whitespace in a tool name would forge a different
 * tool name out of one legitimate one.
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
 * The same rule for the SERVER half of the identifier. A projected server name
 * is interpolated into the runtime tool name `mcp__<server>__<tool>`
 * (`./projection.ts`): a quote, comma, or space would forge a second name out
 * of one.
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
 * One observed server together with the toolset it was projected from.
 *
 * The toolset id is the daemon's fact, not the server's, so it is attached
 * here rather than inside {@link McpServerObservation}: the core observes
 * servers and knows nothing about the registry. Carrying it ON the entry
 * instead of in a parallel `serverName -> toolsetId` map is deliberate — two
 * structures that must agree are two structures that can disagree, and the
 * projection's ordering is derived from it.
 */
export interface McpToolsetServerObservation extends McpServerObservation {
    readonly toolsetId: string;
}
/** Join one raw server observation to the toolset that projected it. */
export declare function bindMcpToolsetServerObservation(observation: McpServerObservation, toolsetId: string): McpToolsetServerObservation;
export interface ObserveMcpServerOptions extends Omit<McpStdioClientOptions, 'maxStdoutBytes'> {
    /** Total initialize + tools/list budget, including every page; cleanup is awaited separately. */
    readonly timeoutMs?: number;
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
// ==== @byok-sdk/client dist/native-interactions.d.ts ====
/** Native permission scope is explicit. There is intentionally no persistent grant. */
export type NativeApprovalDecision = 'allow-once' | 'allow-session' | 'deny' | 'cancel';
export interface NativeInteractionCapabilities {
    readonly approvalDecisions: readonly NativeApprovalDecision[];
    readonly structuredQuestions: boolean;
}
export interface NativeInteractionIdentity {
    /** Exact provider wire ID, including its original string/number type. */
    readonly id: string | number;
    readonly method: string;
    readonly sessionRef: string;
    readonly turnId?: string;
    readonly itemId?: string;
}
export interface NativeQuestion {
    readonly id: string;
    readonly prompt: string;
    readonly header?: string;
    readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
    }[];
    readonly multiple: boolean;
    readonly allowText: boolean;
    readonly secret?: boolean;
}
export type NativeInteractionInput = {
    readonly native: NativeInteractionIdentity;
} & ({
    readonly kind: 'approval';
    readonly title: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly decisions: readonly NativeApprovalDecision[];
} | {
    readonly kind: 'question';
    readonly questions: readonly NativeQuestion[];
});
export type NativeInteractionRequest = NativeInteractionInput & {
    /** SDK identity, unique across process generations, never a tool call ID. */
    readonly requestId: string;
    readonly generation: string;
    readonly expiresAt: number;
};
export interface NativeQuestionAnswer {
    readonly questionId: string;
    readonly selectedOptionIds: readonly string[];
    readonly text?: string;
}
export type NativeInteractionResponse = {
    readonly requestId: string;
} & ({
    readonly kind: 'approval';
    readonly decision: NativeApprovalDecision;
} | {
    readonly kind: 'question';
    readonly answers: readonly NativeQuestionAnswer[];
} | {
    readonly kind: 'cancel';
});
export type NativeInteractionEndReason = 'provider-cancelled' | 'interrupted' | 'turn-ended' | 'process-exited' | 'closed';
export interface NativeInteractionReceipt {
    readonly requestId: string;
    readonly status: 'responded' | 'cancelled' | 'timed-out' | 'failed';
    readonly reason?: NativeInteractionEndReason | 'deadline' | 'transport';
}
/** Local host surface. A snapshot contains only requests still awaiting a decision. */
export interface NativeInteractionChannel {
    readonly generation: string;
    pending(): readonly NativeInteractionRequest[];
    respond(response: NativeInteractionResponse): Promise<NativeInteractionReceipt>;
}
export interface NativeInteractionOptions {
    readonly onRequest: (request: NativeInteractionRequest, channel: NativeInteractionChannel) => void | Promise<void>;
    readonly onResolved?: (receipt: NativeInteractionReceipt) => void | Promise<void>;
    /** Required owner action for an uncertain/failed native write; normally terminate the owned process. */
    readonly onFatal: (error: NativeInteractionError) => void | Promise<void>;
    readonly timeoutMs?: number;
    readonly writeTimeoutMs?: number;
    readonly maxPending?: number;
    /** All request identities/tombstones are retained up to this lifetime bound; none are evicted/reused. */
    readonly maxRequests?: number;
}
/** Adapter consumers supply presentation hooks; the adapter always owns fatal transport disposal. */
export type NativeInteractionHostOptions = Omit<NativeInteractionOptions, 'onFatal'>;
export interface NativeInteractionTransport {
    respond(response: NativeInteractionResponse): Promise<void>;
    cancel(reason: 'deadline' | 'cancelled'): Promise<void>;
}
export type NativeInteractionErrorCode = 'invalid_request' | 'invalid_response' | 'unknown_request' | 'duplicate_request' | 'response_conflict' | 'request_settled' | 'closed' | 'capacity' | 'transport';
export declare class NativeInteractionError extends Error {
    readonly code: NativeInteractionErrorCode;
    constructor(code: NativeInteractionErrorCode, message: string);
}
/** Internal adapter boundary: snapshot and validate local UI configuration before any process side effect. */
export declare function snapshotNativeInteractionHostOptions(options: NativeInteractionHostOptions): NativeInteractionHostOptions;
/**
 * One process lifetime's request registry. A resumed runtime gets a new controller;
 * native IDs from its previous process are never reconstructed or replayed here.
 * This is a local adapter/Host seam, not a remote authorization or persistence API.
 */
export declare class NativeInteractionController {
    private readonly options;
    readonly channel: NativeInteractionChannel;
    private readonly entries;
    private readonly nativeIds;
    private readonly generation;
    private readonly timeoutMs;
    private readonly writeTimeoutMs;
    private readonly maxPending;
    private readonly maxRequests;
    private closed;
    private fatal;
    constructor(options: NativeInteractionOptions);
    open(input: NativeInteractionInput, transport: NativeInteractionTransport): NativeInteractionRequest;
    /** Provider cancellation/turn end does not write another native answer. */
    withdraw(requestId: string, reason?: NativeInteractionEndReason): void;
    /** Process exit/close invalidates all outstanding requests, without replay or transport writes. */
    close(reason?: NativeInteractionEndReason): void;
    private respond;
    private write;
    private settle;
}
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
// ==== @byok-sdk/client dist/runtime-detection.d.ts ====
import type { RuntimeId } from '@byok-sdk/protocol';
import { type ServiceEnvironmentUnavailableCode } from './login-shell-environment';
import { type RuntimeAdapter, type RuntimeAdapterDescriptor, type RuntimeDetectResult, type RuntimeDetectionRefusalReason, type RuntimeExecutableSource, type RuntimeVersionVerdict } from './types';
/** How one restart changed an installed runtime's version token (#1103 §2.6). */
export type RuntimeVersionChangeDirection = 'upgrade' | 'downgrade' | 'changed' | 'unknown';
/** The local, restart-only version comparison; never sent on the wire or into audit. */
export interface RuntimeVersionChange {
    readonly fromVersion: string;
    readonly toVersion: string;
    readonly direction: RuntimeVersionChangeDirection;
    readonly observedAt: string;
}
/** Content-free observation of one configured adapter, including unavailable outcomes. */
export interface RuntimeObservation {
    id: string;
    present: boolean;
    outcome: RuntimeDetectResult['kind'];
    reason?: RuntimeDetectionRefusalReason;
    /** With `reason: 'runtime_environment_unavailable'`: why the login-shell capture failed. */
    code?: ServiceEnvironmentUnavailableCode;
    version?: string;
    qualifiedVersion?: string;
    /**
     * The effective version policy's verdict (#1103). Local-only: `Daemon.status()`
     * carries it inline, while control `status` ships it through the additive
     * `runtimeVersionVerdicts` side channel so a pre-#1103 client's strict
     * observation parser still accepts `runtimes`. `doctor` merges the two. The
     * wire still carries only the protocol's `RuntimeInfo` fields. Additive and
     * optional: an observation from an older daemon has no verdict, and a reader
     * must not infer `allow` from its absence.
     */
    versionVerdict?: RuntimeVersionVerdict;
    /**
     * #1103 §2.6: this run's comparison with the last stored token. Local-only
     * (status, doctor, startup stderr); never on the wire, in audit or in a
     * support bundle. Absent on a first run, an unchanged version, an
     * unavailable runtime, or an older daemon.
     */
    versionChange?: RuntimeVersionChange;
    /**
     * #1103 O10: the absolute executable detection ran, and who chose it.
     * Local-only (`Daemon.status()`, control `status` through the additive
     * `runtimeExecutables` side channel, `doctor`); never on the wire, in audit
     * or in a support bundle, because the path can name the local user. Absent
     * when detection did not run an executable it can name: an unavailable
     * runtime, a bare command the OS finds on PATH at spawn (source `path`
     * only), a Pi lane that launches an SDK entry, or an older daemon.
     */
    executablePath?: string;
    executableSource?: RuntimeExecutableSource;
    authPresent?: boolean;
    steer: boolean;
    resume: boolean;
}
/** The daemon and explicit local probes project the same detection authority. */
export declare function projectRuntimeObservation(descriptor: RuntimeAdapterDescriptor, detected: RuntimeDetectResult): RuntimeObservation;
/** Reject unreadable observations; never infer availability from an older discovery shape. */
export declare function parseRuntimeObservations(value: unknown): RuntimeObservation[] | undefined;
/**
 * Merge the control status's additive {@link RuntimeVersionVerdict} channel
 * (#1103) into observations. The verdicts travel outside `runtimes` so a
 * pre-#1103 client's strict observation parser still accepts that array; a
 * missing or malformed side channel means "unknown", never `allow`.
 *
 * @internal
 */
export declare function attachRuntimeVersionVerdicts(observations: RuntimeObservation[], value: unknown): RuntimeObservation[];
/**
 * Merge the control status's additive {@link RuntimeVersionChange} channel
 * (#1103 §2.6) into observations. The change travels outside `runtimes` so a
 * pre-#1103 client's strict observation parser still accepts that array; a
 * missing or malformed side channel means "unknown", never "unchanged".
 *
 * @internal
 */
export declare function attachRuntimeVersionChanges(observations: RuntimeObservation[], value: unknown): RuntimeObservation[];
/**
 * Merge the control status's additive executable channel (#1103 O10) into
 * observations, under the same side-channel rule as
 * {@link attachRuntimeVersionChanges}. A missing or malformed entry means
 * unknown; the reader never resolves a path itself.
 *
 * @internal
 */
export declare function attachRuntimeExecutables(observations: RuntimeObservation[], value: unknown): RuntimeObservation[];
/** Reject legacy/mixed authoring shapes; copy only validated, known facts. */
export declare function validateRuntimeDetectResult(value: unknown): RuntimeDetectResult;
/**
 * Single routing author for daemon, selection and local diagnostics. A host
 * platform outside `descriptor.platforms` is refused before `detect()` runs.
 */
export declare function observeRuntimeDetection(adapter: RuntimeAdapter, signal?: AbortSignal): Promise<RuntimeDetectResult>;
/** Whether `id` is a frozen wire runtime id. Every other adapter id is selected by `harnessId`. */
export declare function isWireRuntimeId(id: string): id is RuntimeId;
/** The task selection that reaches this adapter: `runtime` for a wire runtime id, else `harnessId`. Never both. */
export declare function taskRuntimeTarget(descriptor: Pick<RuntimeAdapterDescriptor, 'id'>): {
    readonly runtime: RuntimeId;
} | {
    readonly harnessId: string;
};
// ==== @byok-sdk/client dist/runtime-failure.d.ts ====
import type { RuntimeFailureClass, TaskFailure } from '@byok-sdk/protocol';
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
    /**
     * The runtime's failure class, from structured runtime evidence only (#869);
     * omitted means `unknown`. `resetsAt` exists only on `quota`, only when the
     * runtime reported it, written as `Date#toISOString` writes it.
     */
    failure?: TaskFailure;
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
    readonly failure: TaskFailure;
    constructor(input: RuntimeExecutionFailureInput, options?: ErrorOptions);
}
/** A class string a runtime reported, or `unknown` when it is none of the closed classes. */
export declare function runtimeFailureClassOf(value: unknown): RuntimeFailureClass;
export declare function isRuntimeExecutionFailure(value: unknown): value is RuntimeExecutionFailure;
export interface RuntimeFailureProjection {
    reason: string;
    retryable: boolean;
    failure: TaskFailure;
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
// ==== @byok-sdk/client dist/runtime/environment.d.ts ====
import { type LoginShellSnapshot, type ServiceEnvironmentUnavailableCode } from '../login-shell-environment';
/**
 * The environment of every child process of a task: the runtime CLI and the
 * MCP servers the daemon probes for it (#1095).
 *
 * {@link buildRuntimeEnvironment} builds it from a
 * {@link RuntimeEnvironmentPolicy}, which each runtime adapter owns:
 *
 * - `login-shell` (default): the user's login-shell snapshot
 *   (`../login-shell-environment.ts`), never the daemon's live
 *   environment, so a variable an embedding Host puts into `process.env` does
 *   not reach the runtime. A failed capture fails closed with
 *   {@link RuntimeEnvironmentUnavailableError}. On win32, which has no login
 *   shell, the base is {@link WINDOWS_SESSION_NAMES} from the live session
 *   environment.
 * - `allowlist`: the platform baseline plus `allow`, from the live
 *   environment; it needs no snapshot.
 *
 * Then, in order: the adapter's conflict rule removes names from the base;
 * `pass` copies the named variables from the live environment at every build;
 * the hard deny removes `CLAUDECODE` (Claude Code sets it inside its own
 * sessions; a child agent starts as its own top-level session) and `BYOK_*`
 * (this SDK's control-plane variables), whatever listed them; `NO_PROXY` and
 * `no_proxy` gain `127.0.0.1` and `localhost`, so a user's proxy never takes
 * the traffic to the daemon's loopback gate and MCP servers.
 *
 * {@link buildAllowlistedEnv} is the narrow form over a given environment. It
 * is used by the durable Pi tool shell, the prepared Pi lane on the Pi auth
 * store, and Hermes launcher or custody paths.
 *
 * Every name in every list may be an exact match or a `*`-suffixed prefix
 * (e.g. `'LC_*'` matches `LC_ALL`, `LC_CTYPE`, ...).
 *
 * The same pass that builds the environment builds its
 * {@link RuntimeEnvironmentReport}: every name with its source, and the names
 * the hard deny or the conflict rule removed. Never a value. `byok-agent
 * doctor` reads it from the running daemon (`runtimes.environment`).
 */
/** Inputs to {@link buildAllowlistedEnv}. */
export interface BuildAllowlistedEnvOptions {
    /**
     * The ambient environment (normally `process.env`). Never mutated — every
     * returned variable is copied into a fresh object.
     */
    ambient: Readonly<Record<string, string | undefined>>;
    /** Names admitted beyond the platform baseline, still subject to the hard deny. */
    allow?: readonly string[];
    /**
     * Test seam: which platform's extra base vars to include
     * ({@link WINDOWS_BASE_ALLOWLIST} vs none) — defaults to `process.platform`
     * so callers never have to think about it, while still letting a test
     * exercise the win32 branch deterministically on any host OS.
     */
    platform?: NodeJS.Platform;
}
/**
 * Which environment a runtime adapter gives its children (see this module's
 * doc comment). `pass` names variables taken from the live `process.env` at
 * every build, for a Host that sets them after it starts. Names never match
 * `CLAUDECODE` or `BYOK_*`.
 */
export type RuntimeEnvironmentPolicy = {
    readonly base?: 'login-shell';
    readonly pass?: readonly string[];
} | {
    readonly base: 'allowlist';
    readonly allow?: readonly string[];
    readonly pass?: readonly string[];
};
/**
 * An adapter's conflict rule: given the names `pass` actually supplied, the
 * names (or `*` prefixes) to remove from the base. On win32 the supplied
 * names arrive in upper case and the removed names match case-insensitively.
 */
export type RuntimeEnvironmentConflictRule = (passed: ReadonlySet<string>) => readonly string[];
/**
 * Where a runtime environment name came from: the base (`login-shell`,
 * `windows-session` or `allowlist`), the policy's `pass`, or `sdk` for the
 * `NO_PROXY`/`no_proxy` this module writes.
 */
export type RuntimeEnvironmentSource = 'login-shell' | 'windows-session' | 'allowlist' | 'pass' | 'sdk';
/** The rule that kept a name out: the hard deny (`CLAUDECODE`, `BYOK_*`) or the adapter's conflict rule. */
export type RuntimeEnvironmentRemovalRule = 'deny' | 'conflict';
/**
 * The names of one runtime environment, sorted, never their values. `removed`
 * lists the names a base or `pass` admitted and a rule then kept out, so a
 * name is in exactly one of the two lists.
 */
export interface RuntimeEnvironmentReport {
    readonly names: readonly {
        readonly name: string;
        readonly source: RuntimeEnvironmentSource;
    }[];
    readonly removed: readonly {
        readonly name: string;
        readonly rule: RuntimeEnvironmentRemovalRule;
    }[];
}
/** One build: the environment and its {@link RuntimeEnvironmentReport}. `env` is a fresh object. */
export interface RuntimeEnvironment {
    readonly env: Record<string, string>;
    readonly report: RuntimeEnvironmentReport;
}
/** The login-shell capture failed, so no `login-shell` runtime environment exists in this process. */
export declare class RuntimeEnvironmentUnavailableError extends Error {
    readonly reason: ServiceEnvironmentUnavailableCode;
    readonly code: 'runtime_environment_unavailable';
    constructor(reason: ServiceEnvironmentUnavailableCode);
}
/** Validates a policy at the adapter or daemon boundary and returns a frozen copy. */
export declare function assertRuntimeEnvironmentPolicy(value: unknown, label: string): RuntimeEnvironmentPolicy;
/** Inputs to {@link composeRuntimeEnvironment}. */
export interface ComposeRuntimeEnvironmentInput {
    policy: RuntimeEnvironmentPolicy;
    /** Required for `login-shell` off win32. */
    snapshot?: LoginShellSnapshot;
    /** The live environment (normally `process.env`). Never mutated. */
    live: Readonly<Record<string, string | undefined>>;
    conflicts?: RuntimeEnvironmentConflictRule;
    platform?: NodeJS.Platform;
}
/**
 * The synchronous core of {@link buildRuntimeEnvironment}: a fresh
 * environment and its report from the given snapshot and live environment.
 *
 * @internal
 */
export declare function composeRuntimeEnvironment(input: ComposeRuntimeEnvironmentInput): RuntimeEnvironment;
/**
 * The environment every child process of a task receives under `policy`, and
 * its report, from this process's login-shell snapshot (captured on first
 * use) and the live `process.env`. Throws
 * {@link RuntimeEnvironmentUnavailableError} when `login-shell` has no
 * snapshot to build from.
 */
export declare function buildRuntimeEnvironment(policy: RuntimeEnvironmentPolicy, conflicts?: RuntimeEnvironmentConflictRule): Promise<RuntimeEnvironment>;
/**
 * The platform baseline plus `options.allow`, minus the hard deny (see this
 * module's own doc comment for its callers).
 */
export declare function buildAllowlistedEnv(options: BuildAllowlistedEnvOptions): Record<string, string>;
// ==== @byok-sdk/client dist/sdk-native-assets-runtime.d.ts ====
/** Runtime loader: explicit absolute root only, no download or package-search fallback. */
export declare function loadSdkKoffiAsset(root: string): unknown;
// ==== @byok-sdk/client dist/sdk-native-assets.d.ts ====
import { type SdkReservedHelperKind } from './sdk-reserved-helper-host';
export declare const sdkNativeAssetTargets: Readonly<{
    'win32-x64': Readonly<{
        package: "@koromix/koffi-win32-x64";
        version: "3.2.0";
        sha256: "c2345e8178dc3cac051e1066c7082028d3096959050bcf3e6d46a0e839e64b3f";
        url: "https://registry.npmjs.org/@koromix/koffi-win32-x64/-/koffi-win32-x64-3.2.0.tgz";
        integrity: "sha512-09p81HVKDsLXkyMRrLQzsFtCjdcFgbRW765roAu5iChHj4gfWVrGDdvtBldc1BulIEgH1/gRwa2E4vEtW3/hlw==";
        files: readonly string[];
        signingPolicy: "unmodified-official-addon";
        agentMemoryHelper: Readonly<{
            files: readonly string[];
            signingPolicy: "product-resigning-allowed";
        }>;
    }>;
    darwin: Readonly<{
        files: readonly string[];
        signingPolicy: "product-resigning-allowed";
    }>;
}>;
export interface CopySdkNativeAssetsOptions {
    readonly outDir: string;
    readonly platform: 'win32' | 'darwin';
    readonly arch: 'x64' | 'arm64';
}
/** Build-time only. Fetches the integrity-pinned official Windows archive on any build host; never executes it. Both platforms copy the Agent memory helper through the release-helper copier. */
export declare function copySdkNativeAssets(options: CopySdkNativeAssetsOptions): Promise<readonly string[]>;
export { loadSdkKoffiAsset } from './sdk-native-assets-runtime';
/**
 * What a single-file product does with each published bin. `cli`: the daemon CLI, not shipped by an embedded Host.
 * `reserved-helper` and `pi-host`: re-entered through `sdkHelperHost` as `kind`. `provider-launcher`: the keys
 * custody launcher, which the product re-enters as its own command with `runPiProviderLauncher`.
 */
export type SdkDistributionBinRole = 'cli' | 'reserved-helper' | 'pi-host' | 'provider-launcher';
export interface SdkDistributionBin {
    readonly package: '@byok-sdk/client' | '@byok-sdk/keys';
    readonly role: SdkDistributionBinRole;
    readonly kind?: SdkReservedHelperKind;
}
/**
 * The supported single-file formats. Every format ships the same asset layout (`copySdkPackagingAssets` in
 * `@byok-sdk/client/packaging`): `pi` is `PI_PACKAGE_DIR`, `native` is `nativeAssetRoot` and
 * `native/agent-memory-fs` is `agentMemoryHelperAssetRoot`, where the platform has native targets.
 */
export declare const sdkPackagingFormats: Readonly<{
    readonly esm: Readonly<{
        esbuildFormat: "esm";
        helperHost: "node-entry";
        piRuntimeForm: "interpreter+bundle";
    }>;
    readonly cjs: Readonly<{
        esbuildFormat: "cjs";
        helperHost: "node-entry";
        piRuntimeForm: "interpreter+bundle";
    }>;
    readonly sea: Readonly<{
        esbuildFormat: "cjs";
        helperHost: "executable";
        piRuntimeForm: "interpreter+bundle";
    }>;
}>;
export type SdkPackagingFormat = keyof typeof sdkPackagingFormats;
export declare const sdkPackagingAssetLayout: Readonly<{
    readonly pi: 'pi';
    readonly native: 'native';
    readonly agentMemoryHelper: 'native/agent-memory-fs';
}>;
/** Machine-readable build inputs. Target presence is not runtime/platform qualification. */
export declare const sdkDistributionManifest: Readonly<{
    version: 1;
    piRuntimePin: string;
    nodeEngine: string;
    bins: Readonly<Readonly<Record<string, SdkDistributionBin>>>;
    reservedHelperKinds: readonly SdkReservedHelperKind[];
    nativeTargets: Readonly<{
        'win32-x64': Readonly<{
            package: "@koromix/koffi-win32-x64";
            version: "3.2.0";
            sha256: "c2345e8178dc3cac051e1066c7082028d3096959050bcf3e6d46a0e839e64b3f";
            url: "https://registry.npmjs.org/@koromix/koffi-win32-x64/-/koffi-win32-x64-3.2.0.tgz";
            integrity: "sha512-09p81HVKDsLXkyMRrLQzsFtCjdcFgbRW765roAu5iChHj4gfWVrGDdvtBldc1BulIEgH1/gRwa2E4vEtW3/hlw==";
            files: readonly string[];
            signingPolicy: "unmodified-official-addon";
            agentMemoryHelper: Readonly<{
                files: readonly string[];
                signingPolicy: "product-resigning-allowed";
            }>;
        }>;
        darwin: Readonly<{
            files: readonly string[];
            signingPolicy: "product-resigning-allowed";
        }>;
    }>;
    formats: Readonly<{
        readonly esm: Readonly<{
            esbuildFormat: "esm";
            helperHost: "node-entry";
            piRuntimeForm: "interpreter+bundle";
        }>;
        readonly cjs: Readonly<{
            esbuildFormat: "cjs";
            helperHost: "node-entry";
            piRuntimeForm: "interpreter+bundle";
        }>;
        readonly sea: Readonly<{
            esbuildFormat: "cjs";
            helperHost: "executable";
            piRuntimeForm: "interpreter+bundle";
        }>;
    }>;
    assetLayout: Readonly<{
        readonly pi: 'pi';
        readonly native: 'native';
        readonly agentMemoryHelper: 'native/agent-memory-fs';
    }>;
}>;
// ==== @byok-sdk/client dist/sdk-reserved-helper-host.d.ts ====
export declare const BYOK_SDK_HELPER_SUBCOMMAND = "__byok_sdk_helper";
export type SdkReservedHelperKind = 'agent-message-mcp' | 'agent-result-mcp' | 'agent-memory-mcp' | 'agent-memory-describe' | 'agent-team-mcp' | 'pi-rpc' | 'pi-prepared' | 'pi-durable';
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
/** The exact kinds that `runSdkReservedHelperCommand` accepts. */
export declare const sdkReservedHelperKinds: readonly SdkReservedHelperKind[];
/** SDK-owned launcher shape used by every reserved stdio helper. */
export declare function resolveSdkReservedHelperBin(kind: SdkReservedHelperKind, host?: SdkHelperHostConfig): ResolvedSdkReservedHelperBin;
/**
 * The helper host of a single-file product, called from inside that product. A
 * Node SEA re-enters its own executable; a bundle run by Node re-enters Node
 * with the running bundle as its entry. `node:sea` decides which, so nothing is
 * inferred from paths or names.
 */
export declare function bundledSdkHelperHost(): SdkHelperHostConfig & {
    readonly executable: string;
};
// ==== @byok-sdk/client dist/sdk-reserved-mcp.d.ts ====
/** SDK-owned names shared by daemon injection, adapter policy, and MCP helpers. */
export declare const AGENT_MESSAGE_MCP_SERVER_NAME = "byokagentmessage";
export declare const AGENT_MESSAGE_TOOL_NAME = "send_agent_message";
export declare const AGENT_MEMORY_MCP_SERVER_NAME = "byokagentmemory";
export declare const AGENT_MEMORY_RECALL_TOOL_NAME = "memory_recall";
export declare const AGENT_MEMORY_SAVE_TOOL_NAME = "memory_save";
export declare const AGENT_TEAM_MCP_SERVER_NAME = "byokagentteam";
export declare const TEAM_POST_TOOL_NAME = "post_team_message";
export declare const TEAM_READ_TOOL_NAME = "read_team_messages";
export declare const TEAM_ACK_TOOL_NAME = "ack_team_messages";
/** The structured outcome channel of a `terminalProjection.mode: 'result-document'` offer (wire v3). */
export declare const AGENT_RESULT_MCP_SERVER_NAME = "byokagentresult";
/** Its one tool; the `inputSchema` it advertises is the offer's frozen result schema. */
export declare const AGENT_RESULT_TOOL_NAME = "submit_result";
export declare const AGENT_RESULT_TOOL_DESCRIPTION = "Submit the structured outcome required by this execution. A staged receipt confirms durable storage, not execution success.";
/**
 * Every MCP server name the SDK owns. A server under one of these names is
 * never a projected host toolset server: `toolset-registry.ts` refuses to
 * configure one, and the adapters grant each reserved server exactly the
 * fixed tool its own protocol needs rather than anything observed.
 *
 * A frozen tuple rather than a `Set`: `Object.freeze` on a `Set` freezes the
 * object's own properties and leaves `add`/`delete` fully functional, so the
 * previous shape advertised an immutability it did not have. Four entries
 * make `includes` the same cost as a hash lookup, and the array really is
 * immutable. Use {@link isReservedMcpServerName} rather than reaching for
 * membership directly.
 */
export declare const RESERVED_MCP_SERVER_NAMES: readonly ["byokagentmessage", "byokagentmemory", "byokagentteam", "byokagentresult"];
/** Whether `name` is one of the SDK-owned MCP server names above. */
export declare function isReservedMcpServerName(name: string): boolean;
/** Fixed helper protocols; runtime-discovered or host tool names cannot grant themselves approval. */
export declare const SDK_RESERVED_MCP_TOOL_NAMES: Readonly<{
    byokagentmessage: readonly string[];
    byokagentmemory: readonly string[];
    byokagentteam: readonly string[];
    byokagentresult: readonly string[];
}>;
// ==== @byok-sdk/client dist/testing/index.d.ts ====
import { type RuntimeEnvironment } from '../runtime/environment';
import type { RuntimeAdapter, RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult, RuntimeDetectResult } from '../types';
/** The built-in adapters a fake can stand in for. */
export type FakeRuntimeAdapterId = 'claude' | 'codex' | 'grok' | 'hermes' | 'pi';
/** What the fake does. It never spawns a process. */
export interface FakeRuntimeAdapterBehavior {
    /** Default: `{ kind: 'available' }`. A function is called on every probe. */
    readonly detect?: RuntimeDetectResult | ((signal?: AbortSignal) => Promise<RuntimeDetectResult>);
    /** Default: a non-retryable reject, so a fake starts nothing the test did not supply. */
    readonly prepare?: (input: RuntimeAdapterPrepareInput) => Promise<RuntimeAdapterPrepareResult>;
    /** Default: the `allowlist` runtime environment, which takes no login-shell snapshot. */
    readonly runtimeEnvironment?: () => Promise<RuntimeEnvironment>;
}
/**
 * A runtime adapter double whose descriptor is the real adapter's default
 * descriptor, so its capabilities, selection target and platforms follow the
 * SDK. Only `detect`, `prepare` and `runtimeEnvironment` are the test's.
 */
export declare function fakeRuntimeAdapter(id: FakeRuntimeAdapterId, behavior?: FakeRuntimeAdapterBehavior): RuntimeAdapter;
// ==== @byok-sdk/client dist/tool-authorization.d.ts ====
import type { AgentRef } from './agent-home';
/**
 * The only product tool-authorization modes, chosen by the local Host per task
 * and shared by every runtime:
 * - `all`: every tool runs; high-risk calls produce a reminder, never a denial.
 * - `auto`: every tool runs except high-risk calls, which wait for user
 *   authorization before execution.
 * Neither mode is an OS sandbox or a file-scope boundary.
 */
export type ToolAuthorizationMode = 'auto' | 'all';
export declare const TOOL_AUTHORIZATION_MODES: readonly ToolAuthorizationMode[];
/** The access one file-scope root grants. `write` implies `read`. */
export type ToolFileAccess = 'read' | 'write';
export declare const TOOL_FILE_ACCESS: readonly ToolFileAccess[];
/**
 * One explicit additional workspace root of a file-scope policy. `id` is for
 * local audit/display only; `path` is a local, already-existing directory the
 * Host configures, never a model or wire value.
 */
export interface ToolFileScopeRoot {
    /** Unique, nonempty local label; never emitted on the wire. */
    readonly id: string;
    /** Absolute local path; canonicalized and identity-checked at admission, not here. */
    readonly path: string;
    /** `write` implies `read`. */
    readonly access: ToolFileAccess;
}
/**
 * The optional explicit file scope of a tool-authorization policy (#1061
 * slice 1, D15). Absent means `inherit`: the current behavior is unchanged.
 * `home` authorizes read+write of the canonical Agent home; `workspaces`
 * additionally authorizes the listed roots. Only legal when the offer's
 * effective mode is `auto`.
 */
export interface ToolFileScope {
    /** `home` always grants read+write of the canonical Agent home. */
    readonly mode: 'home' | 'workspaces';
    /** Only for `workspaces`; at least one unique-id, existing absolute root. */
    readonly roots?: readonly ToolFileScopeRoot[];
}
/** The lane an offer runs in; file-scope support is per lane, not per runtime. */
export type ToolAuthorizationLane = 'rpc' | 'prepared' | 'durable';
/** A writer owns the canonical Agent home; memory-reader offers have a different cwd authority. */
export type ToolAuthorizationHomeAccess = 'writer' | 'memory-reader';
/** Local facts the Host decides on; never sourced from the wire offer or the model. */
export interface ToolAuthorizationTask {
    readonly taskId: string;
    readonly runtimeId: string;
    readonly agentRef?: AgentRef;
    /** Additive: the resolved lane, so a Host resolver can select a per-lane file scope. */
    readonly lane?: ToolAuthorizationLane;
    /** Additive: the resolved home access of this offer. */
    readonly homeAccess?: ToolAuthorizationHomeAccess;
}
export interface ToolRule {
    readonly id: string;
    /** Host display text, never interpreted as executable policy. */
    readonly description?: string;
    readonly match: {
        /** Exact, case-sensitive native tool name. */
        readonly toolName?: string;
        readonly commandGlob?: string;
        readonly pathGlob?: string;
        readonly mcpServer?: string;
        readonly mcpTool?: string;
    };
}
export interface ToolAuthorizationRules {
    readonly alwaysAsk?: readonly ToolRule[];
    readonly allowWithoutAsking?: readonly ToolRule[];
}
/**
 * The one tool-authorization policy `DaemonConfig.toolAuthorization` accepts,
 * whether it comes from a config file or an embedded Host. It is copied,
 * validated and frozen by {@link parseToolAuthorizationPolicy} at admission.
 */
export interface ToolAuthorizationPolicy {
    /** Mode for every runtime without a `byRuntime` entry. */
    readonly default: ToolAuthorizationMode;
    /** Per-runtime override, keyed by runtime id. */
    readonly byRuntime?: Readonly<Record<string, ToolAuthorizationMode>>;
    /** User-defined rules that move single calls across the ask boundary. */
    readonly rules?: ToolAuthorizationRules;
    /**
     * Optional explicit file scope (#1061, D15). Absent means `inherit` and
     * preserves the existing behavior exactly. Only legal when the offer's
     * effective mode is `auto`; an `all` runtime with a scope is rejected
     * before claim. An unsupported lane/adapter/platform is declined as
     * `file_scope_unsupported` before claim; on the admitted POSIX path every
     * root is revalidated after claim, before runtime start, and again before
     * the Pi session exists, and an unresolvable root fails the claimed task as
     * `file_scope_unavailable`. A configured scope is never silently dropped.
     * SDK-owned scoped read/write/edit/find/grep/ls tools enforce the admitted
     * roots and shadow the native Pi tools of the same name. Every other tool
     * (shell, MCP servers, SDK and user extension tools) is outside the boundary
     * and asks on every call, regardless of the built-in risk level; only an
     * explicit allowWithoutAsking rule can opt one out. It is not an OS sandbox.
     */
    readonly fileScope?: ToolFileScope;
}
/** Internal per-offer derivation; never part of the public config surface. */
export type ToolAuthorizationResolver = (task: ToolAuthorizationTask) => ToolAuthorizationPolicy;
/** The mode `policy` gives `runtimeId`: its own `byRuntime` entry, else `default`. */
export declare function toolAuthorizationMode(policy: Pick<ToolAuthorizationPolicy, 'default' | 'byRuntime'>, runtimeId: string): ToolAuthorizationMode;
/**
 * Derive the daemon's internal resolver from one policy. The snapshot is
 * taken now, so later edits to `policy` cannot change a decision; rules apply
 * unchanged to every runtime.
 */
export declare function toolAuthorizationResolver(policy: ToolAuthorizationPolicy): ToolAuthorizationResolver;
export declare function parseToolAuthorizationMode(value: unknown): ToolAuthorizationMode;
/**
 * A syntactically invalid file-scope policy. It is a `TypeError` like the
 * rest of admission, and its `code` lets `checkDaemonConfig` report the
 * typed `invalid_file_scope` issue instead of a generic value error.
 */
export declare class FileScopePolicyError extends TypeError {
    readonly code: 'invalid_file_scope';
    constructor(message: string);
}
/** The admission boundary: one copied, frozen policy for every source. */
export declare function parseToolAuthorizationPolicy(value: unknown): ToolAuthorizationPolicy;
/** One native tool call, before execution. `input` is the runtime's own argument object. */
export interface ToolCall {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: Readonly<Record<string, unknown>>;
    /** The runtime's working directory for this call; relative paths resolve against it. */
    readonly cwd: string;
    readonly nativeAgentId?: string;
    readonly parentToolCallId?: string;
    /** Trusted admitted identity; not inferred from a native tool's spelling. */
    readonly mcp?: {
        readonly server: string;
        readonly tool: string;
    };
}
export type ToolRiskReason = 'privilege-escalation' | 'recursive-delete' | 'system-modification' | 'destructive-git' | 'publish-or-deploy' | 'remote-script-execution' | 'permission-broadening' | 'sensitive-path' | 'write-outside-workspace' | 'custom-rule' | 'outside-file-scope';
export interface ToolAuthorizationReason {
    readonly source: 'rule' | 'built-in' | 'floor';
    readonly ruleIds: readonly string[];
}
export type ToolRisk = {
    readonly level: 'normal';
    readonly authorization: ToolAuthorizationReason;
    readonly suppressedReasons?: readonly ToolRiskReason[];
} | {
    readonly level: 'high';
    readonly reasons: readonly ToolRiskReason[];
    readonly authorization: ToolAuthorizationReason;
};
/** Home-relative credential stores and login persistence points. */
export declare const SENSITIVE_HOME_PATHS: readonly string[];
/**
 * The single classifier for both modes. Protected-path identity also follows
 * the nearest existing ancestor; uncertainty cannot activate an allow rule.
 * `workspace` is the daemon's grant, not the runtime-reported cwd.
 */
export declare function classifyToolCall(call: Pick<ToolCall, 'toolName' | 'input' | 'cwd' | 'mcp'>, workspace: string, home?: string, rules?: ToolAuthorizationRules, context?: {
    readonly platform?: NodeJS.Platform;
}): ToolRisk;
export type ToolAuthorizationDenialCode = 'tool_authorization_denied' | 'tool_authorization_unavailable';
export type ToolAuthorizationVerdict = {
    readonly decision: 'allow';
    readonly authorization?: ToolAuthorizationReason;
} | {
    readonly decision: 'deny';
    readonly code: ToolAuthorizationDenialCode;
    readonly reason: string;
    readonly authorization?: ToolAuthorizationReason;
};
/** Local audit projection; raw tool arguments and rule descriptions stay private. */
export interface ToolAuthorizationDecision {
    readonly taskId: string;
    readonly toolName: string;
    readonly toolCallId?: string;
    readonly decision: 'allow' | 'deny';
    readonly authorization: ToolAuthorizationReason;
    readonly reasons: readonly ToolRiskReason[];
    readonly suppressedReasons?: readonly ToolRiskReason[];
    readonly code?: ToolAuthorizationDenialCode;
}
/**
 * The `auto` gate a daemon hands to an adapter that declares
 * `toolAuthorizationAuto`. The adapter calls it for every native tool call
 * before execution; it never throws.
 */
export interface ToolAuthorizationGate {
    /**
     * Wall-clock bound on one decision, measured from the `authorize` call and
     * covering any wait behind earlier approvals. An adapter's native hook
     * deadline must exceed it.
     */
    readonly timeoutMs: number;
    /** The adapter may supply its trusted runtime observation, never identity from tool arguments. */
    authorize(call: ToolCall, resolveMcpIdentity?: () => Promise<{
        readonly server: string;
        readonly tool: string;
    } | undefined>): Promise<ToolAuthorizationVerdict>;
}
export declare function describeHighRiskToolCall(call: Pick<ToolCall, 'toolName' | 'input' | 'mcp'>, reasons: readonly ToolRiskReason[], authorization?: ToolAuthorizationReason): string;
export declare function createAutoToolAuthorizationGate(input: {
    readonly workspace: string;
    readonly home?: string;
    readonly platform?: NodeJS.Platform;
    readonly timeoutMs: number;
    readonly rules?: ToolAuthorizationRules;
    readonly mcpIdentities?: ReadonlyMap<string, {
        readonly server: string;
        readonly tool: string;
    }>;
    /** Called for every classified decision and for a denial that happened before classification. */
    readonly onDecision?: (decision: {
        readonly call: ToolCall;
        readonly risk?: ToolRisk;
        readonly verdict: ToolAuthorizationVerdict;
    }) => void;
    /** Aborting `signal` must withdraw the request so a later decision cannot revive it. */
    readonly requestAuthorization: (summary: string, signal: AbortSignal) => Promise<{
        approved: boolean;
        reason?: string;
    }>;
}): ToolAuthorizationGate;
export declare function formatToolAuthorizationDenial(verdict: Extract<ToolAuthorizationVerdict, {
    decision: 'deny';
}>): string;
/** An `all`-mode notice for one high-risk call the runtime reported; the call was not blocked. */
export interface ToolReminder {
    readonly taskId: string;
    readonly toolName: string;
    readonly toolCallId?: string;
    readonly reasons: readonly ToolRiskReason[];
    readonly summary: string;
    readonly authorization: ToolAuthorizationReason;
    readonly suppressedReasons?: readonly ToolRiskReason[];
}
// ==== @byok-sdk/client dist/types.d.ts ====
import type { ServiceEnvironmentUnavailableCode } from './login-shell-environment';
import type { RuntimeEnvironment } from './runtime/environment';
import type { ExecutionScratch } from './daemon/retention/scratch';
import type { NativeInteractionCapabilities, NativeInteractionChannel } from './native-interactions';
import type { ToolAuthorizationGate } from './tool-authorization';
import type { PreparedAgentMemoryMode } from '@byok-sdk/protocol';
import type { PreparedAgentMemoryState } from './agent-memory/prepared-agent-memory';
import type { PiRuntimeLaunchResources } from './adapters/pi/runtime-launch';
import type { AgentEvent, TaskOfferPlainPayload } from '@byok-sdk/protocol';
import type { InputPreparationModelV1 } from './input-preparation';
import type { AgentRef } from './agent-home';
import type { McpToolsetServerObservation } from './mcp/observation';
export type { AgentRef } from './agent-home';
/**
 * The offer fields a runtime adapter receives. The client owns this shape;
 * the daemon projects each wire offer onto it.
 */
export type RuntimeTaskInput = Pick<TaskOfferPlainPayload, 'runtime' | 'harnessId' | 'dispatchSelection' | 'limits'> & {
    instruction: NonNullable<TaskOfferPlainPayload['instruction']>;
    /** The runtime session to resume (`session.mode: 'resume'` on the offer); absent for a fresh session. */
    sessionRef?: string;
};
export type { McpServerObservation, McpToolDescriptor, McpToolsetServerObservation, } from './mcp/observation';
export type { AgentEgressPolicy } from '@byok-sdk/protocol';
/**
 * Failure vocabulary shared by the detection contract and local diagnostics.
 */
export declare const RUNTIME_DETECTION_FAILURE_KINDS: readonly ['not-found', 'not-executable', 'timeout', 'probe-failed', 'refused'];
/**
 * One version predicate (#1103). Only an exact token or a component-boundary
 * prefix: no range, no minimum/maximum, no regular expression and no semver
 * dependency, so the policy can never become a second version comparator.
 */
export type RuntimeVersionSpec = {
    readonly kind: 'exact';
    readonly version: string;
} | {
    readonly kind: 'prefix';
    readonly prefix: string;
};
/**
 * Pure, serializable version policy (#1103). The descriptor default, an
 * adapter option and `DaemonConfig.runtimes.<id>.versionPolicy` are complete
 * objects that replace one another wholesale through
 * `resolveRuntimeVersionPolicy`; a field is never merged across them.
 */
export interface RuntimeVersionPolicy {
    /** The normalized token this SDK was qualified against, for example `0.160.0`. */
    readonly qualifiedVersion: string;
    /** What an unmatched token means. A descriptor default may not use `block`; only a Host layer may. */
    readonly unqualified: 'allow' | 'warn' | 'block';
    /** Explicitly known-good versions outside the qualified range. */
    readonly allow?: readonly RuntimeVersionSpec[];
    /** Versions that must stay a warning even where `unqualified` is `allow`. */
    readonly warn?: readonly RuntimeVersionSpec[];
    /** Versions this Host refuses before claim. Host layer only. */
    readonly block?: readonly RuntimeVersionSpec[];
}
/** The one policy verdict for an installed runtime token (#1103). `matched` names the spec that decided a non-qualified verdict. */
export type RuntimeVersionVerdict = {
    readonly state: 'allow';
    readonly qualifiedVersion: string;
    readonly matched?: string;
} | {
    readonly state: 'warn';
    readonly qualifiedVersion: string;
    readonly matched?: string;
} | {
    readonly state: 'block';
    readonly qualifiedVersion: string;
    readonly matched: string;
};
/**
 * Who chose the runtime executable (#1103 O10): `config` the adapter's Host
 * `resolveBin` option, `env` a `BYOK_<RUNTIME>_BIN` variable, `path` a bare
 * name found on the runtime environment's PATH.
 */
export type RuntimeExecutableSource = 'config' | 'path' | 'env';
/**
 * One probe outcome, never a separately authored presence boolean. Authentication
 * observation is each adapter's native non-secret login-state probe (a status
 * command, credential env-var names, or Pi's shape-only agent-dir login check)
 * and never returns, logs, or retains a credential value. Failure variants
 * contain no arbitrary diagnostics.
 */
export type RuntimeDetectResult = {
    readonly kind: 'available';
    readonly version?: string;
    readonly authPresent?: boolean;
    readonly advisory?: RuntimeDetectionAdvisory;
    readonly versionVerdict?: RuntimeVersionVerdict;
    /** The absolute executable this probe ran (#1103 O10). Local-only and user-path sensitive: never on the wire, in audit or in a support bundle. */
    readonly executablePath?: string;
    /** Who chose that executable; present whenever `executablePath` is. */
    readonly executableSource?: RuntimeExecutableSource;
} | {
    readonly kind: Exclude<typeof RUNTIME_DETECTION_FAILURE_KINDS[number], 'refused'>;
} | {
    readonly kind: 'refused';
    readonly reason: Exclude<RuntimeDetectionRefusalReason, 'runtime_environment_unavailable'>;
} | {
    readonly kind: 'refused';
    readonly reason: 'runtime_environment_unavailable';
    readonly code: ServiceEnvironmentUnavailableCode;
};
/**
 * A local agent updates itself, so a version the SDK was not qualified against
 * is a warning, not a refusal. `version` on the result carries what was found.
 */
export interface RuntimeDetectionAdvisory {
    readonly reason: 'runtime_version_unqualified';
    readonly qualifiedVersion: string;
}
/**
 * `app_server_unavailable`: Codex has no `app-server`. `acp_unavailable`: an ACP runtime has no stdio ACP mode.
 * `platform_unsupported`: the host platform is not in {@link RuntimeAdapterDescriptor.platforms}; no probe ran.
 * `runtime_environment_unavailable`: the login-shell capture failed (`code`), so the runtime has no environment to start in (#1095).
 */
export type RuntimeDetectionRefusalReason = 'app_server_unavailable' | 'acp_unavailable' | 'platform_unsupported' | 'runtime_environment_unavailable';
/**
 * Each `true` is a guarantee the runtime contract suite checks; `false` means
 * the SDK makes no such guarantee for this runtime (#1103).
 */
export interface RuntimeIsolationCapabilities {
    /** User-level instructions (a user `CLAUDE.md`, `AGENTS.md` or rules) can be kept out. */
    readonly userContext: boolean;
    /** MCP servers the user configured for the runtime can be kept out. */
    readonly userMcpServers: boolean;
    /** The runtime's own transcript store can be turned off. */
    readonly sessionPersistence: boolean;
}
/** What a runtime adapter can do, advertised so the daemon can pick/validate adapters. */
export interface RuntimeCapabilities {
    /**
     * Enforces the `auto` tool authorization gate before every native tool call
     * of an ordinary instruction start. Omission means `auto` tasks are declined
     * for this adapter before claim; `all` needs no adapter support.
     */
    readonly toolAuthorizationAuto?: boolean;
    /** Supports display-only Agent message drafts. Omission means unsupported. */
    readonly messageDraft?: boolean;
    /** Local native interaction support only; omission is unsupported. Not the approval channel. */
    readonly nativeInteractions?: NativeInteractionCapabilities;
    /** The durable Pi worker. Omission means an ordinary adapter. */
    readonly durablePi?: boolean;
    /**
     * Accepts a prepared offer (the prepared lane). Omission means unsupported.
     * `auto` never applies to a prepared offer, whatever `toolAuthorizationAuto` says.
     */
    readonly preparedLane?: boolean;
    /** Which user-level sources the adapter keeps out of a Bot session. Omission means none. */
    readonly isolation?: RuntimeIsolationCapabilities;
    readonly steer: boolean;
    readonly resume: boolean;
    /**
     * Whether this adapter can project task-scoped, locally configured MCP
     * servers into the runtime without accepting executable definitions from
     * the remote task. Omission is fail-closed and means unsupported.
     */
    readonly mcpToolsets?: boolean;
    /**
     * Whether this adapter's sessions call
     * {@link RuntimeOperationStartInput.approvalChannel}'s `request` and wait
     * for the decision. Only such an adapter is handed the channel. It is also
     * the sole source of the wire's `RuntimeInfo.capabilities.approvalInteractive`.
     *
     * Required, deliberately: a new adapter (or a test fake) that forgets to
     * declare it fails to compile rather than silently defaulting to a claim
     * it cannot back.
     */
    readonly approvalInteractive: boolean;
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
    mcpServers: Readonly<Record<string, McpStdioServerConfig & {
        /** Exact Host-approved tool names; omitted or empty adds no approval. Local configuration only. */
        readonly approveTools?: readonly string[];
    }>>;
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
 * The one way a session asks for approval. TaskRunner hands it only to an
 * adapter that declares `approvalInteractive: true`.
 */
export interface ApprovalChannel {
    /**
     * Sends `task.await_approval` for this task and waits for the decision: a
     * wire `task.approve`/`task.reject`, a local `Daemon.approve`/`reject` or
     * `approvals.resolve`, or a fail-closed rejection on timeout, task finish or
     * eviction. The session resumes or stops its runtime from the result.
     */
    request(summary: string): Promise<{
        approved: boolean;
        reason?: string;
    }>;
}
/**
 * Display-only text for the daemon's Agent message draft lane. It is not an
 * `AgentEvent`: the daemon never batches, records or replies with it. The
 * adapter's own message tracker sets `startsMessage` on the first non-blank
 * delta of a new message, and each later `progress` event reconciles the draft.
 */
export interface MessageDraftDelta {
    type: 'message_draft_delta';
    text: string;
    startsMessage: boolean;
}
/**
 * A running (or resumable) unit of work on a runtime. One `Session` maps to
 * one underlying runtime process/session for the lifetime of a task.
 */
export interface Session {
    /** Process-generation-bound native requests. Never reconstructed from a resumed transcript. */
    readonly interactions?: NativeInteractionChannel;
    /** Opaque runtime session id, reported back to the server via `task.complete.sessionRef`. */
    sessionRef: string;
    /** Normalized events for this session; the daemon batches these into `task.progress`. A `MessageDraftDelta` only feeds the display-only draft. */
    events: AsyncIterable<AgentEvent | MessageDraftDelta>;
    /**
     * For an adapter whose descriptor sets `progressEventsAreMessages` but
     * emits one assistant message as several `progress` events. Return false
     * when `event`, an object this session's `events` yielded, continues the
     * message of an earlier event: the daemon then keeps both in the same
     * closing reply. Absent: every non-blank `progress` event starts a message.
     */
    progressStartsMessage?(event: Extract<AgentEvent, {
        type: 'progress';
    }>): boolean;
    /** Inject steering text into a running turn (mid-stream). */
    steer(text: string): Promise<void>;
    /** Send a new instruction on the same session after it has gone idle. */
    followUp(task: RuntimeTaskInput): Promise<void>;
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
     * Runtime output this session could not turn into `events`, as counts for
     * the whole session up to `close()`. The daemon reads it once, after
     * `close()` resolved, and only when the descriptor declares
     * `trajectoryEvidence`. A declaring adapter that omits it states that
     * nothing below its event stream can drop or invent a frame.
     */
    evidence?(): SessionEvidence;
}
/** Counts behind one session's event stream; see {@link Session.evidence}. Never a frame, a line or a tool payload. */
export interface SessionEvidence {
    /** Runtime output frames that could not be decoded, including a truncated frame left at the end of the stream. */
    readonly decodeDropped: number;
    /** Decoded frames of a type the adapter neither maps to an event nor expects as bookkeeping. */
    readonly unmappedFrames: number;
    /** Tool results the adapter produced itself instead of observing them from the runtime. */
    readonly syntheticToolResults: number;
}
/**
 * Immutable runtime facts shared by discovery and one prepared operation.
 *
 * The SDK snapshots this value before each offer and never consults adapter
 * capability authority again during admission, claim or start.
 */
export interface RuntimeAdapterDescriptor {
    readonly id: string;
    readonly capabilities: RuntimeCapabilities;
    /**
     * The effective version policy (#1103), already resolved and frozen by the
     * adapter constructor. Absent for a custom adapter with no policy.
     */
    readonly versionPolicy?: RuntimeVersionPolicy;
    /** Explicit opt-in to authoritative `task.offer.dispatchSelection` semantics. */
    readonly supportsDispatchSelection: boolean;
    /**
     * Whether this adapter actually CONSUMES
     * {@link RuntimeAdapterPrepareInput.mcpToolsetTools} — i.e. whether it
     * needs the daemon to observe each projected toolset server before
     * admission, because it registers those tools itself: pi registers one tool
     * per observed MCP tool with the server's own schema. Claude and Codex
     * attach the MCP servers and let the runtime list the tools itself, so they
     * declare nothing.
     *
     * The daemon uses this, and only this, to decide whether to pay for the
     * pre-admission `tools/list` observation of every projected server
     * (`daemon/mcp-tools-probe.ts`). An adapter that consumes no observation
     * never makes an offer wait on one it has no use for.
     */
    readonly requiresMcpToolsetToolObservation?: boolean;
    /** Can enforce the local Host's exact per-tool MCP approvals. Nonempty grants require this capability. */
    readonly mcpToolApprovals?: boolean;
    /**
     * Whether each `progress` event carries one complete assistant message
     * rather than a streaming delta. Codex emits one event per completed
     * `agentMessage`, and Claude one per complete text block, so commentary and
     * the final answer arrive as separate events with no tool interaction
     * between them. When this is true, the
     * daemon starts a new closing reply at every `progress` event, so the
     * closing reply (`task.complete.finalMessage`) is the last message only.
     * Absent or false: consecutive `progress` events form one reply until a
     * tool interaction.
     */
    readonly progressEventsAreMessages?: boolean;
    /**
     * Declares `Session.events` as the evidence source of the daemon's local
     * execution record (`daemon/execution-record.ts`): every tool call and
     * result carries its `toolCallId`, and `turn_end` means the runtime
     * completed. Absent: every record of this adapter is `unknown`.
     */
    readonly trajectoryEvidence?: 'event-stream';
    /**
     * The `process.platform` values this adapter supports. Runtime detection
     * refuses every other platform with `platform_unsupported` before it runs a
     * probe. Absent: no platform restriction (a custom adapter's default).
     */
    readonly platforms?: readonly NodeJS.Platform[];
}
/** The pure input to one adapter admission decision. It contains no credential values or workspace resources. */
export interface RuntimeAdapterPrepareInput {
    /** Admission cancellation; late pure results are discarded and never started. */
    signal?: AbortSignal;
    offer: RuntimeTaskInput;
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
 * `inputSchema` — plus the server identity and negotiated protocol version.
 * pi registers one tool per MCP tool with the real schema; the prepared launch
 * path binds the schema digest into a frozen tool manifest.
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
    /** Required by prepared operations, absent on ordinary operations. */
    readonly agentMemory?: PreparedAgentMemoryMode;
    readonly taskId: string;
    /** Selected runtime id; lane/provider/model, when present, live only in `dispatchSelection`. */
    readonly runtimeId: string;
    readonly descriptor: RuntimeAdapterDescriptor;
    readonly requiredToolsetIds: readonly string[];
    /** The credential-free runtime/lane/provider/model authority for this operation. */
    readonly dispatchSelection?: RuntimeTaskInput['dispatchSelection'];
    readonly sessionRef?: string;
    /** Strict Agent identity, present on every `task.offer`. */
    readonly agentRef?: AgentRef;
    /**
     * Canonical runtime cwd. For an Agent writer it is the Agent home root. For
     * a `memory-reader` Attempt it is the run directory
     * `<home>/.byok/runs/<taskId>/`, and `lease.canonicalHome` names the home.
     */
    readonly cwd?: string;
    /**
     * Present for a `memory-reader` Agent Attempt only. An adapter whose runtime
     * does not read instruction files from ancestors of `cwd` uses it to point
     * the runtime at `lease.canonicalHome`.
     */
    readonly homeAccess?: 'memory-reader';
    /** Opaque local lease identity sealed with the Agent manifest. */
    readonly lease?: {
        readonly leaseId: string;
        readonly canonicalHome: string;
    };
    readonly workspace: {
        readonly workspaceDir: string;
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
 * The independently trusted expectations the prepared-input verifier
 * requires (`adapters/pi/input-preparation.ts`'s `PreparedPiExpectedV1`).
 *
 * They come from the DURABLE record — its artifact summary and its binding —
 * never from the artifact file itself. The verifier contract is explicit that a
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
 */
export interface RuntimePreparedLaunchV1 {
    readonly terminalProjection?: import('@byok-sdk/protocol').TerminalProjectionSelection;
    readonly agentMemory: PreparedAgentMemoryMode;
    readonly memory: PreparedAgentMemoryState | null;
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
    readonly toolBindingDigest: string;
    readonly observationDigest: string;
    /** `toolsetId` -> the registry definition revision the preparation bound. */
    readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
}
/** Trusted daemon barriers for the opt-in durable worker; never serialized. */
export interface DurableLifecycle {
    record(kind: 'tool-intent' | 'tool-committed' | 'respawn-intent', ordinal: number): Promise<void>;
    ownsLease(): boolean;
}
/** Runtime resources shared by every start variant. */
interface RuntimeOperationStartBase {
    readonly scratch: ExecutionScratch;
    /** Exact local resource acquired by this operation before resume handoff validation; never serialized. */
    readonly sessionLease?: RuntimeSessionLease;
    /** Trusted parent-only recovery authority; never serialized into the worker. */
    readonly durableContext?: {
        readonly tenantId: string;
        readonly lifecycle: DurableLifecycle;
        readonly replicaRoot: string;
    };
    readonly runtimeLaunch?: PiRuntimeLaunchResources;
    /** Exact daemon MCP admission environment; Pi requires it and never inherits runtime credentials. */
    readonly mcpEnv?: Readonly<Record<string, string>>;
    /** Startup cancellation only; rejection must preserve unresolved process ownership. */
    readonly signal?: AbortSignal;
    readonly manifest: RuntimeOperationManifest;
    readonly env: NodeJS.ProcessEnv;
    /** Local MCP authority resolved from logical wire ids. */
    readonly mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
    /** Local registry approvals copied and frozen with this attempt's servers; never sourced from wire or transcript. */
    readonly mcpToolApprovals?: Readonly<Record<string, readonly string[]>>;
    /** {@link McpToolsetToolObservation} for exactly the projected toolset servers in `mcpServers`. */
    readonly mcpToolsetTools?: McpToolsetToolObservation;
    /**
     * Present only when the adapter declares `approvalInteractive: true`. A
     * request made before `start()` returns waits until the task is active.
     * `start()` must return its Session before awaiting the request's decision.
     */
    readonly approvalChannel?: ApprovalChannel;
    /**
     * Present only for an `auto` task on an adapter declaring
     * `toolAuthorizationAuto`. Every native tool call must pass it before
     * execution; a denial becomes the tool's error result.
     */
    readonly toolAuthorization?: ToolAuthorizationGate;
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
/** Retains runtime-owned session data until runtime disposal succeeds. Release is idempotent. */
export interface RuntimeSessionLease {
    readonly sessionRef: string;
    release(): Promise<void>;
}
/** A pinned provider/runtime decision. `start()` receives resources only, never a raw offer. */
export interface PreparedRuntimeOperation {
    /**
     * Acquire before validating a resume handoff. The caller retains this resource across
     * admission/startup and passes the exact object to start; release only after disposal,
     * or on an offer that never started. Absent when the runtime owns no swept session data.
     */
    acquireSessionLease?(sessionRef: string): Promise<RuntimeSessionLease | undefined>;
    /** Resource phase after workspace resolution and before claim; never reads a credential. */
    resolveRuntimeLaunch?(input: {
        kind: 'instruction' | 'prepared';
        cwd: string;
        env: Readonly<Record<string, string | undefined>>;
        scratch: ExecutionScratch;
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
    prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult>;
    /**
     * The environment every child process of this runtime's tasks receives
     * (#1095), built under the adapter's own `RuntimeEnvironmentPolicy`
     * (`buildRuntimeEnvironment`): a fresh `env` and, from the same pass, the
     * `report` of its names and sources that `byok-agent doctor` shows. Rejects
     * with `RuntimeEnvironmentUnavailableError` when that policy has no
     * environment to build from; the daemon then refuses the runtime.
     */
    runtimeEnvironment(): Promise<RuntimeEnvironment>;
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
// ==== @byok-sdk/client dist/util/agent-memory-helper-release.d.ts ====
/** Resolve SDK release assets only: package-installed by default, or a complete SDK-copied product directory. No PATH or caller digest. */
export declare function resolveAgentMemoryFilesystemHelper(assetRoot?: string): string;
export declare function verifyAgentMemoryFilesystemHelper(helperBin: string, assetRoot?: string): string;
/** Build-time copy of the SDK release manifest and the targets of one platform into a new or empty product asset directory. */
export interface CopyAgentMemoryHelperAssetsOptions {
    readonly outDir: string;
    /** `darwin` (default) copies both Darwin targets; `win32` copies the Windows x64 target. */
    readonly platform?: 'darwin' | 'win32';
}
/**
 * Run against an installed SDK release, then ship these files with the product.
 * The manifest and the Mach-O or PE digest detect deployment errors, not signer trust.
 * Product re-signing remains supported. Returns sorted paths relative to outDir.
 */
export declare function copyAgentMemoryHelperAssets(options: CopyAgentMemoryHelperAssetsOptions): Promise<readonly string[]>;
// ==== @byok-sdk/client dist/util/exec-runner.d.ts ====
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
// ==== @byok-sdk/client dist/util/secure-dir.d.ts ====
import { type Runner } from './exec-runner';
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
 * `util/exec-runner.ts`'s `defaultRunner`), which is never a shell and
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
    /** DI for tests — see `util/exec-runner.ts`'s identical `Runner` seam. Defaults to `defaultRunner` (real `execFile`, never a shell). */
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
/**
 * Creates `<parent>/<prefix>` plus six random letters and digits (the name
 * mkdtemp would give, which the retention sweep matches) with one exclusive
 * mkdir, mode 0700; on Windows it inherits the parent's ACL. It replaces
 * fs.mkdtemp, which on Windows fails with ENOENT once the path passes
 * MAX_PATH while mkdir does not (#1097). An existing name throws EEXIST.
 */
export declare function createPrivateTempDir(parent: string, prefix: string): Promise<string>;
/**
 * A private scratch directory directly under the canonical OS temp root, for
 * a tool whose own path limit is shorter than the store's: the Windows
 * credential bridge is compiled with `Add-Type`/csc, which fails with CS2021
 * once the output name is too long, and the CS2021 limit is on the directory
 * it is handed (#1097). Its length therefore cannot depend on where the store
 * lives. The leaf is created by an exclusive mkdir under the real path of the
 * temp root, so a pre-planted symlink or junction is never followed, and
 * {@link ensureSecureDir} applies the same owner-only restriction every other
 * scratch root gets. The caller removes it.
 */
export declare function createPrivateSystemTempDir(prefix: string): Promise<string>;
// ==== @byok-sdk/client dist/util/sqlite-support.d.ts ====
import type { DatabaseSync } from 'node:sqlite';
/**
 * The path handed to SQLite, which is not always the path the rest of the code
 * uses. On Windows the SQLite VFS does not apply the extended-length prefix
 * itself: past the legacy MAX_PATH the open fails, and a failed open is
 * indistinguishable from a damaged file at the call site (the journal would
 * quarantine a healthy database and refuse to start). The prefix is applied
 * only when the path is long enough to need it, so ordinary installs keep the
 * plain path.
 */
export declare function sqliteOpenPath(path: string, platform?: NodeJS.Platform): string;
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
 * Synchronously load `node:sqlite` via `process.getBuiltinModule` rather than a dynamic
 * `import()`. `DatabaseSync`'s entire API is synchronous, and the journal is
 * constructed synchronously from `createDaemonWithAdapters` alongside every
 * other daemon-local store (`DeviceStore`, `CursorStore`, ...) — an async
 * factory here would leak into every one of those call sites for nothing.
 * The built-in lookup needs no file URL, including in CJS bundles and SEA
 * executables. Memoized: the throw is re-derived per call from
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
// ==== @byok-sdk/client dist/util/team-tmux-view.d.ts ====
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

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { PERMISSION_MODES, type PermissionMode, type TaskState } from '@byok-sdk/protocol';
import type { ApprovalDecision, PendingApproval } from './approvals';
import type { StorageCategory } from './journal/journal';
import type { StoragePressureState } from './journal/storage-policy';
import type { OperationalHealthSnapshot } from './operational-health';
import type { LocalAgentReleaseIdentity } from '../release-identity';
import type { McpToolsetConfig, McpToolsetRegistryStatus } from '../types';
import type { AgentHomeExecutionStatus } from '../agent-home';
import type {
  InputPreparationCancelParamsV1,
  InputPreparationLookupParamsV1,
  InputPreparationModelV1,
  InputPreparationOptionsV1,
  InputPreparationPromptSnapshotV1,
  InputPreparationReceiptV1,
  InputPreparationRequestV1,
  InputPreparationScopeClaimV1,
  InputPreparationSnapshotV1,
  InputPreparationUserMessageV1,
} from '../input-preparation';
import {
  INPUT_PREPARATION_REQUEST_FORMAT,
  INPUT_PREPARATION_RETIRED_REQUEST_KEYS,
  INPUT_PREPARATION_RETIRED_SNAPSHOT_KEYS,
  INPUT_PREPARATION_VERSION,
} from '../input-preparation';


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

export const CONTROL_PROTOCOL_VERSION = 1;

/** Handshake must complete within this long, on both sides — see each side's own timer. */
export const HANDSHAKE_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Endpoint path / pipe name derivation
// ---------------------------------------------------------------------------

/**
 * Conservative soft limit for a Unix domain socket path, in UTF-8 bytes.
 * macOS's `sockaddr_un.sun_path` is 104 bytes total (including the NUL
 * terminator and any prefix the kernel reserves), so anything comfortably
 * under 104 avoids `ENAMETOOLONG` at `bind()`/`connect()` time on the
 * tightest common platform.
 */
const UNIX_SOCKET_PATH_SOFT_LIMIT = 100;

/**
 * The one fixed root the long-path fallback below binds under. Deliberately
 * NOT `os.tmpdir()`, which reads `TMPDIR`/`TMP`/`TEMP` — an endpoint address
 * that varies with the environment is not an endpoint both sides can find,
 * and a caller may have pointed `TMPDIR` INSIDE the very tree that made the
 * natural path too long, where `os.tmpdir()` yields an address LONGER than
 * the one being escaped (`bind()` then fails `EINVAL` and the daemon degrades
 * to no control socket at all). A literal `/tmp` is POSIX-guaranteed,
 * environment-independent, and short enough that this candidate always fits
 * the budget above. Same fix, same reasons as `daemon-owner.ts`'s
 * `STORE_MUTEX_FALLBACK_ROOT`; kept as its own constant because the two
 * derivations differ in name and ownership contract and must stay
 * independently readable.
 */
const CONTROL_SOCKET_FALLBACK_ROOT = '/tmp';

function shortHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

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
export function controlSocketPath(storeDir: string): string {
  const candidate = path.join(storeDir, 'control.sock');
  if (Buffer.byteLength(candidate, 'utf8') <= UNIX_SOCKET_PATH_SOFT_LIMIT) return candidate;
  return path.join(CONTROL_SOCKET_FALLBACK_ROOT, `byok-${shortHash(storeDir)}`, 'sock');
}

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
export function controlPipeName(productId: string, storeDir: string): string {
  const id = shortHash(`${productId}|${path.resolve(storeDir)}`);
  return `\\\\.\\pipe\\byok-${id}`;
}

/**
 * Dispatches to {@link controlPipeName} on `win32`, {@link controlSocketPath}
 * everywhere else. `platform` defaults to `process.platform`; overridable
 * for tests exercising a specific platform's branch on any host (mirrors
 * `lifecycle/create-service-lifecycle.ts`'s identical `platform` override —
 * the REAL win32 named-pipe semantics can only be proven on actual Windows,
 * which CI's `ipc-smoke` job does; this override just makes the PATH-CHOICE
 * logic itself testable everywhere).
 */
export function controlEndpointPath(productId: string, storeDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? controlPipeName(productId, storeDir) : controlSocketPath(storeDir);
}

/** Where the daemon writes its per-session control-auth token (see the handshake section below). Always a real file, even on Windows (pipes have no path of their own to piggyback secrets on). */
export function controlTokenPath(storeDir: string): string {
  return path.join(storeDir, 'control.token');
}

// ---------------------------------------------------------------------------
// Handshake: mutual HMAC proof, token never sent over the wire
// ---------------------------------------------------------------------------

const SERVER_PROOF_LABEL = 'byok-control-server|';
const CLIENT_AUTH_LABEL = 'byok-control-client|';

export function randomNonceHex(): string {
  return randomBytes(32).toString('hex');
}

function hmacHex(token: string, message: string): string {
  return createHmac('sha256', token).update(message, 'utf8').digest('hex');
}

/** What the server proves to the client: it holds `token`, bound to the client's own nonce so a captured proof can't be replayed against a different handshake. */
export function computeServerProof(token: string, clientNonce: string): string {
  return hmacHex(token, SERVER_PROOF_LABEL + clientNonce);
}

/** What the client proves to the server, symmetrically, bound to the server's nonce. */
export function computeClientAuth(token: string, serverNonce: string): string {
  return hmacHex(token, CLIENT_AUTH_LABEL + serverNonce);
}

/** Constant-time hex-string comparison (`crypto.timingSafeEqual` requires equal-length buffers; a length mismatch is itself a safe, immediate "not equal" — no early-exit on content). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Handshake frame shapes + parsers
// ---------------------------------------------------------------------------

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseClientHello(value: unknown): ClientHello | undefined {
  if (!isRecord(value)) return undefined;
  if (value.v !== CONTROL_PROTOCOL_VERSION || value.hello !== 'client' || typeof value.nonce !== 'string') return undefined;
  return { v: CONTROL_PROTOCOL_VERSION, hello: 'client', nonce: value.nonce };
}

export function parseServerHello(value: unknown): ServerHello | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.v !== CONTROL_PROTOCOL_VERSION ||
    value.hello !== 'server' ||
    typeof value.proof !== 'string' ||
    typeof value.nonce !== 'string'
  ) {
    return undefined;
  }
  return { v: CONTROL_PROTOCOL_VERSION, hello: 'server', proof: value.proof, nonce: value.nonce };
}

export function parseClientAuth(value: unknown): ClientAuth | undefined {
  if (!isRecord(value)) return undefined;
  if (value.v !== CONTROL_PROTOCOL_VERSION || typeof value.auth !== 'string') return undefined;
  return { v: CONTROL_PROTOCOL_VERSION, auth: value.auth };
}

export function parseServerReady(value: unknown): ServerReady | undefined {
  if (!isRecord(value)) return undefined;
  if (value.v !== CONTROL_PROTOCOL_VERSION || value.ready !== true) return undefined;
  return { v: CONTROL_PROTOCOL_VERSION, ready: true };
}

// ---------------------------------------------------------------------------
// RPC frame shapes (post-handshake)
// ---------------------------------------------------------------------------

export interface RawControlRequest {
  /** Not narrowed to `1` here on purpose — an unexpected value is a `bad_version` RESPONSE, not a parse failure; see `control-server.ts`. */
  v: unknown;
  id: string;
  method: string;
  params?: unknown;
}

/** Loose shape check for an incoming request line: only `id`/`method` need to be well-formed for the server to be able to respond at all (including a `bad_version`/`unknown_method` response) — `v` is deliberately passed through unvalidated. */
export function parseRawControlRequest(value: unknown): RawControlRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== 'string' || typeof value.method !== 'string') return undefined;
  return { v: value.v, id: value.id, method: value.method, params: value.params };
}

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

export function encodeFrame(frame: unknown): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Thrown by a method handler to control the wire error `{code, message}` a caller sees — anything else thrown surfaces as a generic `internal_error`. See `control-server.ts`'s dispatch and `bin/control-client.ts`'s `request()` (which re-throws this same class on the client side). */
export class ControlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

// ---------------------------------------------------------------------------
// NDJSON line framing
// ---------------------------------------------------------------------------

/**
 * Bound on a single NDJSON line's byte length. Every real frame this
 * protocol ever sends (handshake frames, requests/responses/events) is well
 * under this — it exists purely as a defensive cap against a misbehaving or
 * hostile peer streaming an unterminated line forever to grow `pending`
 * without bound. Exceeding it is a fail-closed condition: {@link
 * NdjsonLineReader.push} throws, and every caller (`control-server.ts`,
 * `bin/control-client.ts`) destroys the connection on that throw.
 */
export const MAX_LINE_BYTES = 64 * 1024;

/**
 * Buffers raw socket bytes and yields complete lines. Splits on the raw byte
 * `0x0a` BEFORE any UTF-8 decoding (mirrors `bin/audit-log.ts`'s
 * `followAuditLog`) — `0x0A` can only ever appear as an actual newline in
 * valid UTF-8, so this never risks decoding a multi-byte character that
 * happened to straddle a chunk boundary.
 */
export class NdjsonLineReader {
  private pending: Buffer = Buffer.alloc(0);

  /** @throws if the still-unterminated remainder exceeds {@link MAX_LINE_BYTES} — see that constant's own doc comment. */
  push(chunk: Buffer): string[] {
    this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    const lines: string[] = [];
    let newlineIndex: number;
    // eslint-disable-next-line no-cond-assign
    while ((newlineIndex = this.pending.indexOf(0x0a)) !== -1) {
      const line = this.pending.subarray(0, newlineIndex).toString('utf8');
      this.pending = this.pending.subarray(newlineIndex + 1);
      if (line.length > 0) lines.push(line);
    }
    if (this.pending.length > MAX_LINE_BYTES) {
      throw new Error(`NDJSON line exceeded ${MAX_LINE_BYTES} bytes without a terminating newline`);
    }
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Method contracts (Phase 2 surface) — shared by create-daemon.ts's control
// method registry and the CLI commands that call them.
// ---------------------------------------------------------------------------

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
export const ENROLLMENT_PAIRING_CODE_MAX_BYTES = 1024;

export interface EnrollmentPairParams {
  pairingCode: string;
}

/**
 * Exact shape gate for service-identity pairing. The code is opaque server
 * authority: this only bounds transport bytes and rejects unknown fields; it
 * never parses, normalizes or logs the code.
 */
export function parseEnrollmentPairParams(value: unknown): EnrollmentPairParams | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'pairingCode')) return undefined;
  if (
    typeof value.pairingCode !== 'string' ||
    value.pairingCode.length === 0 ||
    Buffer.byteLength(value.pairingCode, 'utf8') > ENROLLMENT_PAIRING_CODE_MAX_BYTES
  ) {
    return undefined;
  }
  return { pairingCode: value.pairingCode };
}

/** Shape-only parser; executable definition validation remains registry-owned. */
export function parseToolsetsReloadParams(value: unknown): ToolsetsReloadParams | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'expectedRevision' && key !== 'mcpToolsets')) {
    return undefined;
  }
  if (typeof value.expectedRevision !== 'string' || !isRecord(value.mcpToolsets) || Array.isArray(value.mcpToolsets)) {
    return undefined;
  }
  return {
    expectedRevision: value.expectedRevision,
    mcpToolsets: value.mcpToolsets as Record<string, McpToolsetConfig>,
  };
}

export interface ApprovalsListResult {
  approvals: PendingApproval[];
}

export type { ApprovalDecision, PendingApproval } from './approvals';

export interface ApprovalsResolveParams {
  approvalId: string;
  decision: ApprovalDecision;
  reason?: string;
}

export function parseApprovalsResolveParams(value: unknown): ApprovalsResolveParams | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.approvalId !== 'string') return undefined;
  if (value.decision !== 'approve' && value.decision !== 'reject') return undefined;
  if (value.reason !== undefined && typeof value.reason !== 'string') return undefined;
  return { approvalId: value.approvalId, decision: value.decision, reason: value.reason };
}

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

export function parseApprovalsRequestParams(value: unknown): ApprovalsRequestParams | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) return undefined;
  if (typeof value.summary !== 'string') return undefined;
  return { taskId: value.taskId, summary: value.summary };
}

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

export function parseAgentMessagePublishParams(value: unknown): AgentMessagePublishParams | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'contextToken' && key !== 'contentType' && key !== 'body')) return undefined;
  if (typeof value.contextToken !== 'string' || value.contextToken.length < 32 || value.contextToken.length > 160) return undefined;
  if (value.contentType !== 'text/plain' && value.contentType !== 'text/markdown') return undefined;
  if (typeof value.body !== 'string' || value.body.length === 0) return undefined;
  return { contextToken: value.contextToken, contentType: value.contentType, body: value.body };
}

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

function validAgentMemoryContextToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32 && value.length <= 160 && !/[\u0000\r\n]/u.test(value);
}

/** Parser only validates the local IPC shape. Agent identity and memory root stay daemon-owned. */
export function parseAgentMemoryRecallParams(value: unknown): AgentMemoryRecallParams | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'contextToken' && key !== 'path' && key !== 'ifRevision')) return undefined;
  if (!validAgentMemoryContextToken(value.contextToken) || typeof value.path !== 'string' || (value.ifRevision !== undefined && typeof value.ifRevision !== 'string')) return undefined;
  return { contextToken: value.contextToken, path: value.path, ...(value.ifRevision === undefined ? {} : { ifRevision: value.ifRevision }) };
}

export function parseAgentMemorySaveParams(value: unknown): AgentMemorySaveParams | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'contextToken' && key !== 'op' && key !== 'path' && key !== 'expectedRevision' && key !== 'content')) return undefined;
  if (!validAgentMemoryContextToken(value.contextToken) || (value.op !== 'replace' && value.op !== 'delete') || typeof value.path !== 'string' || typeof value.expectedRevision !== 'string' || (value.op === 'replace' && typeof value.content !== 'string') || (value.op === 'delete' && value.content !== undefined)) return undefined;
  const content = value.content;
  return { contextToken: value.contextToken, op: value.op, path: value.path, expectedRevision: value.expectedRevision, ...(typeof content === 'string' ? { content } : {}) };
}

// ---------------------------------------------------------------------------
// `assertion.issue` (plan device-assertion-broker)
// ---------------------------------------------------------------------------

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
export const ASSERTION_AUDIENCE_MAX_BYTES = 256;

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
export function parseAssertionIssueParams(value: unknown): AssertionIssueParams | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'audience') return undefined;
  const { audience } = value;
  if (typeof audience !== 'string' || audience.length === 0) return undefined;
  if (Buffer.byteLength(audience, 'utf8') > ASSERTION_AUDIENCE_MAX_BYTES) return undefined;
  return { audience };
}

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
export const ASSERTION_ISSUE_ERROR_CODES = [
  'assertion_disabled',
  'bad_request',
  'audience_denied',
  'shutting_down',
  'revoked',
  'not_paired',
] as const;

export type AssertionIssueErrorCode = (typeof ASSERTION_ISSUE_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// `task_assertion.issue` (contract §8.1 / §8.2(1))
// ---------------------------------------------------------------------------

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
export const TASK_ASSERTION_CONTEXT_TOKEN_MAX_BYTES = 256;

/**
 * Strict shape check. `undefined` means `bad_request`.
 *
 * Rejects an unknown key outright — including `taskId`/`agentRef`/`toolsetId`.
 * A tolerated extra field here is exactly how a caller would come to believe it
 * can influence the claim set, which is the one thing this lane exists to
 * prevent.
 */
export function parseTaskAssertionIssueParams(value: unknown): TaskAssertionIssueParams | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 2) return undefined;
  if (!keys.includes('contextToken') || !keys.includes('audience')) return undefined;
  const { contextToken, audience } = value;
  if (typeof contextToken !== 'string' || contextToken.length === 0) return undefined;
  if (Buffer.byteLength(contextToken, 'utf8') > TASK_ASSERTION_CONTEXT_TOKEN_MAX_BYTES) return undefined;
  if (typeof audience !== 'string' || audience.length === 0) return undefined;
  if (Buffer.byteLength(audience, 'utf8') > ASSERTION_AUDIENCE_MAX_BYTES) return undefined;
  return { contextToken, audience };
}

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
export const TASK_ASSERTION_ISSUE_ERROR_CODES = [
  'assertion_disabled',
  'capability_undeclared',
  'bad_request',
  'audience_denied',
  'shutting_down',
  'revoked',
  'not_paired',
  'context_token_invalid',
  'context_revoked',
] as const;

export type TaskAssertionIssueErrorCode = (typeof TASK_ASSERTION_ISSUE_ERROR_CODES)[number];

export type ShutdownReason = 'unpair' | 'operator';

export interface ShutdownParams {
  reason?: ShutdownReason;
}

export function parseShutdownParams(value: unknown): ShutdownParams {
  if (!isRecord(value)) return {};
  return value.reason === 'unpair' || value.reason === 'operator' ? { reason: value.reason } : {};
}

// ---------------------------------------------------------------------------
// Local TeamWorkspace control methods (local-only; never cloud task wire)
// ---------------------------------------------------------------------------

export interface TeamWorkspaceCreateParams { workspaceId: string; members: string[]; limits: { maxMembers: number; maxMessages: number; maxBytes: number } }
export interface TeamWorkspaceJoinParams { workspaceId: string; memberId: string; ttlMs?: number }
export interface TeamContextParams { context: string }
export interface TeamMessagePostParams extends TeamContextParams { body: string; contentType?: string }
export interface TeamMessageReadParams extends TeamContextParams { afterSeq?: number }
export interface TeamMessageAckParams extends TeamContextParams { throughSeq: number }
export interface TeamMessageInspectParams { workspaceId: string; afterSeq?: number }

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const safeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const contextString = (value: unknown): value is string => typeof value === 'string' && value.length >= 32 && value.length <= 2048 && /^[A-Za-z0-9_-]+$/u.test(value);

export function parseTeamWorkspaceCreateParams(value: unknown): TeamWorkspaceCreateParams | undefined {
  if (!isRecord(value) || !exactKeys(value, ['workspaceId', 'members', 'limits']) || typeof value.workspaceId !== 'string' || !Array.isArray(value.members) || !value.members.every((member) => typeof member === 'string') || !isRecord(value.limits) || !exactKeys(value.limits, ['maxMembers', 'maxMessages', 'maxBytes']) || !safeInteger(value.limits.maxMembers) || !safeInteger(value.limits.maxMessages) || !safeInteger(value.limits.maxBytes)) return undefined;
  return { workspaceId: value.workspaceId, members: [...value.members], limits: { maxMembers: value.limits.maxMembers, maxMessages: value.limits.maxMessages, maxBytes: value.limits.maxBytes } };
}
export function parseTeamWorkspaceJoinParams(value: unknown): TeamWorkspaceJoinParams | undefined {
  if (!isRecord(value) || !exactKeys(value, ['workspaceId', 'memberId', 'ttlMs']) || typeof value.workspaceId !== 'string' || typeof value.memberId !== 'string' || (value.ttlMs !== undefined && !safeInteger(value.ttlMs))) return undefined;
  return { workspaceId: value.workspaceId, memberId: value.memberId, ...(value.ttlMs === undefined ? {} : { ttlMs: value.ttlMs }) };
}
export function parseTeamContextParams(value: unknown): TeamContextParams | undefined {
  if (!isRecord(value) || !exactKeys(value, ['context']) || !contextString(value.context)) return undefined;
  return { context: value.context };
}
export function parseTeamMessagePostParams(value: unknown): TeamMessagePostParams | undefined {
  if (!isRecord(value) || !exactKeys(value, ['context', 'body', 'contentType']) || !contextString(value.context) || typeof value.body !== 'string' || (value.contentType !== undefined && typeof value.contentType !== 'string')) return undefined;
  return { context: value.context, body: value.body, ...(value.contentType === undefined ? {} : { contentType: value.contentType }) };
}
export function parseTeamMessageReadParams(value: unknown): TeamMessageReadParams | undefined {
  if (!isRecord(value) || !exactKeys(value, ['context', 'afterSeq']) || !contextString(value.context) || (value.afterSeq !== undefined && !safeInteger(value.afterSeq))) return undefined;
  return { context: value.context, ...(value.afterSeq === undefined ? {} : { afterSeq: value.afterSeq }) };
}
/** Exact local operator RPC; the shared read-parameter shape has no model identity fields. */
export function parseTeamNotificationSnapshotParams(value: unknown): TeamMessageReadParams | undefined {
  return parseTeamMessageReadParams(value);
}

export function parseTeamMessageAckParams(value: unknown): TeamMessageAckParams | undefined {
  if (!isRecord(value) || !exactKeys(value, ['context', 'throughSeq']) || !contextString(value.context) || !safeInteger(value.throughSeq)) return undefined;
  return { context: value.context, throughSeq: value.throughSeq };
}
export function parseTeamMessageInspectParams(value: unknown): TeamMessageInspectParams | undefined {
  if (!isRecord(value) || !exactKeys(value, ['workspaceId', 'afterSeq']) || typeof value.workspaceId !== 'string' || (value.afterSeq !== undefined && !safeInteger(value.afterSeq))) return undefined;
  return { workspaceId: value.workspaceId, ...(value.afterSeq === undefined ? {} : { afterSeq: value.afterSeq }) };
}

// ---------------------------------------------------------------------------
// `input_preparation.prepare` / `.lookup` / `.cancel` (B-P2 local primitive)
// ---------------------------------------------------------------------------

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
export const INPUT_PREPARATION_PREPARE_METHOD = 'input_preparation.prepare';
export const INPUT_PREPARATION_LOOKUP_METHOD = 'input_preparation.lookup';
export const INPUT_PREPARATION_CANCEL_METHOD = 'input_preparation.cancel';

/** Result of all three methods: exactly one receipt, never a bare digest or a raw artifact. */
export interface InputPreparationResult {
  receipt: InputPreparationReceiptV1;
}

/**
 * Bound on one identifier-shaped wire string (`requestId`, `deviceId`,
 * `agentRef`, `profileId`, revisions, digests). Frame-level only: the values
 * themselves are authority-owned and are never parsed or normalized here.
 */
export const INPUT_PREPARATION_IDENTIFIER_MAX_BYTES = 512;

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function identifier(value: unknown): value is string {
  return boundedString(value, INPUT_PREPARATION_IDENTIFIER_MAX_BYTES);
}

/** `typeof null === 'object'`, and an array is an object too — both must fail a record gate. */
function plainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** A flat `Record<string, string>` with no prototype-polluting keys. */
function stringMap(value: unknown): value is Record<string, string> {
  if (!plainRecord(value)) return false;
  return Object.keys(value).every((key) => key !== '__proto__' && typeof value[key] === 'string');
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseScopeClaim(value: unknown): InputPreparationScopeClaimV1 | undefined {
  if (!plainRecord(value) || !exactKeys(value, ['deviceId', 'agentRef', 'profileId', 'profileRevision'])) return undefined;
  if (!identifier(value.deviceId) || !identifier(value.agentRef) || !identifier(value.profileId) || !identifier(value.profileRevision)) {
    return undefined;
  }
  return {
    deviceId: value.deviceId,
    agentRef: value.agentRef,
    profileId: value.profileId,
    profileRevision: value.profileRevision,
  };
}

function parseModel(value: unknown): InputPreparationModelV1 | undefined {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ['id', 'name', 'api', 'provider', 'baseUrl', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens'])
  ) {
    return undefined;
  }
  if (!identifier(value.id) || !identifier(value.name) || !identifier(value.provider) || !identifier(value.baseUrl)) return undefined;
  // One API, checked here and not translated anywhere: the native first
  // support set compiles openai-completions only.
  if (value.api !== 'openai-completions') return undefined;
  if (typeof value.reasoning !== 'boolean') return undefined;
  if (!Array.isArray(value.input) || value.input.length === 0 || !value.input.every((entry) => entry === 'text' || entry === 'image')) return undefined;
  if (!plainRecord(value.cost) || !exactKeys(value.cost, ['input', 'output', 'cacheRead', 'cacheWrite'])) return undefined;
  const cost = value.cost;
  if (!finiteNumber(cost.input) || !finiteNumber(cost.output) || !finiteNumber(cost.cacheRead) || !finiteNumber(cost.cacheWrite)) return undefined;
  if (!Number.isSafeInteger(value.contextWindow) || (value.contextWindow as number) <= 0) return undefined;
  if (!Number.isSafeInteger(value.maxTokens) || (value.maxTokens as number) <= 0) return undefined;
  return {
    id: value.id,
    name: value.name,
    api: 'openai-completions',
    provider: value.provider,
    baseUrl: value.baseUrl,
    reasoning: value.reasoning,
    input: [...(value.input as ('text' | 'image')[])],
    cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite },
    contextWindow: value.contextWindow as number,
    maxTokens: value.maxTokens as number,
  };
}

function parseOptions(value: unknown): InputPreparationOptionsV1 | undefined {
  if (!plainRecord(value) || !exactKeys(value, ['cacheRetention', 'maxTokens', 'temperature', 'toolChoice', 'reasoningEffort'])) return undefined;
  if (value.cacheRetention !== 'none' && value.cacheRetention !== 'short' && value.cacheRetention !== 'long') return undefined;
  if (!Number.isSafeInteger(value.maxTokens) || (value.maxTokens as number) <= 0) return undefined;
  if (value.temperature !== undefined && !finiteNumber(value.temperature)) return undefined;
  if (value.toolChoice !== undefined && value.toolChoice !== 'auto' && value.toolChoice !== 'none' && value.toolChoice !== 'required') return undefined;
  if (
    value.reasoningEffort !== undefined &&
    !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.reasoningEffort as string)
  ) {
    return undefined;
  }
  return {
    cacheRetention: value.cacheRetention,
    maxTokens: value.maxTokens as number,
    ...(value.temperature === undefined ? {} : { temperature: value.temperature as number }),
    ...(value.toolChoice === undefined ? {} : { toolChoice: value.toolChoice as 'auto' | 'none' | 'required' }),
    ...(value.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: value.reasoningEffort as InputPreparationOptionsV1['reasoningEffort'] }),
  };
}

function parsePromptSnapshot(value: unknown): InputPreparationPromptSnapshotV1 | undefined {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      'customPrompt',
      'appendSystemPrompt',
      'cwd',
      'selectedTools',
      'toolSnippets',
      'promptGuidelines',
      'contextFiles',
      'formattedSkills',
      'docsPaths',
    ])
  ) {
    return undefined;
  }
  if (value.customPrompt !== undefined && typeof value.customPrompt !== 'string') return undefined;
  if (value.appendSystemPrompt !== undefined && typeof value.appendSystemPrompt !== 'string') return undefined;
  if (typeof value.cwd !== 'string' || value.cwd.length === 0) return undefined;
  if (!stringArray(value.selectedTools)) return undefined;
  if (!stringMap(value.toolSnippets)) return undefined;
  if (!stringArray(value.promptGuidelines)) return undefined;
  if (!Array.isArray(value.contextFiles)) return undefined;
  const contextFiles: { path: string; content: string }[] = [];
  for (const entry of value.contextFiles) {
    if (!plainRecord(entry) || !exactKeys(entry, ['path', 'content'])) return undefined;
    if (typeof entry.path !== 'string' || typeof entry.content !== 'string') return undefined;
    contextFiles.push({ path: entry.path, content: entry.content });
  }
  if (typeof value.formattedSkills !== 'string') return undefined;
  if (!plainRecord(value.docsPaths) || !exactKeys(value.docsPaths, ['readmePath', 'docsPath', 'examplesPath'])) return undefined;
  const docs = value.docsPaths;
  if (typeof docs.readmePath !== 'string' || typeof docs.docsPath !== 'string' || typeof docs.examplesPath !== 'string') return undefined;
  return {
    ...(value.customPrompt === undefined ? {} : { customPrompt: value.customPrompt }),
    ...(value.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: value.appendSystemPrompt }),
    cwd: value.cwd,
    selectedTools: [...value.selectedTools],
    toolSnippets: { ...value.toolSnippets },
    promptGuidelines: [...value.promptGuidelines],
    contextFiles,
    formattedSkills: value.formattedSkills,
    docsPaths: { readmePath: docs.readmePath, docsPath: docs.docsPath, examplesPath: docs.examplesPath },
  };
}

/**
 * First support set: text-only user messages. An assistant/toolResult message,
 * array (multimodal) content or any extra field is rejected outright rather
 * than coerced — a silently downgraded message would change what is counted.
 */
function parseMessages(value: unknown): InputPreparationUserMessageV1[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const messages: InputPreparationUserMessageV1[] = [];
  for (const entry of value) {
    if (!plainRecord(entry) || !exactKeys(entry, ['role', 'content', 'timestamp'])) return undefined;
    if (entry.role !== 'user' || typeof entry.content !== 'string') return undefined;
    if (!Number.isSafeInteger(entry.timestamp) || (entry.timestamp as number) < 0) return undefined;
    messages.push({ role: 'user', content: entry.content, timestamp: entry.timestamp as number });
  }
  return messages;
}

function parseSnapshot(value: unknown): InputPreparationSnapshotV1 | undefined {
  // `tools` is NOT parsed here and is not accepted: the model-visible schemas
  // are a local observation assembled by `./prepared-tool-surface.ts`. The
  // retired key is caught by name above this function so the caller hears
  // which authority it tried to assert, rather than a generic shape error.
  if (!plainRecord(value) || !exactKeys(value, ['prompt', 'messages'])) return undefined;
  const prompt = parsePromptSnapshot(value.prompt);
  const messages = parseMessages(value.messages);
  if (!prompt || !messages) return undefined;
  return { prompt, messages };
}

/** Configured MCP toolset ids: non-empty, deduplicated, and each a usable identifier. */
function parseRequiredToolsets(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!identifier(entry) || seen.has(entry)) return undefined;
    seen.add(entry as string);
  }
  return [...seen];
}

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
export type InputPreparationRequestParseResult =
  | { readonly ok: true; readonly request: InputPreparationRequestV1 }
  | { readonly ok: false; readonly code: 'bad_request' | 'unsupported_input'; readonly detail: string };

function badRequest(detail: string): InputPreparationRequestParseResult {
  return { ok: false, code: 'bad_request', detail };
}

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
export function parseInputPreparationRequestParams(value: unknown): InputPreparationRequestParseResult {
  if (!plainRecord(value)) return badRequest('the params must be an object');
  // Named first, and by name: a caller still sending either key is not sending
  // a slightly wrong request, it is claiming an authority this contract moved.
  for (const retired of INPUT_PREPARATION_RETIRED_REQUEST_KEYS) {
    if (retired in value) {
      return {
        ok: false,
        code: 'unsupported_input',
        detail: `this contract no longer accepts ${JSON.stringify(retired)}: tool executor identity is a local`
          + ' observation this daemon derives from `requiredToolsets`, never a value a caller may state',
      };
    }
  }
  if (plainRecord(value.snapshot)) {
    for (const retired of INPUT_PREPARATION_RETIRED_SNAPSHOT_KEYS) {
      if (retired in value.snapshot) {
        return {
          ok: false,
          code: 'unsupported_input',
          detail: `this contract no longer accepts ${JSON.stringify(`snapshot.${retired}`)}: the model-visible tool`
            + ' schemas are a local observation this daemon derives from `requiredToolsets`',
        };
      }
    }
  }
  if (
    !exactKeys(value, [
      'format',
      'version',
      'requestId',
      'policyRevision',
      'scope',
      'source',
      'selection',
      'permissionMode',
      'requiredToolsets',
      'snapshot',
    ])
  ) {
    return badRequest('the params carry a field this request shape does not define');
  }
  if (value.format !== INPUT_PREPARATION_REQUEST_FORMAT || value.version !== INPUT_PREPARATION_VERSION) {
    return badRequest(
      `the request must carry format ${JSON.stringify(INPUT_PREPARATION_REQUEST_FORMAT)}`
      + ` and version ${String(INPUT_PREPARATION_VERSION)}`,
    );
  }
  if (!identifier(value.requestId) || !identifier(value.policyRevision)) {
    return badRequest('requestId and policyRevision must be non-empty single-line identifiers');
  }
  const scope = parseScopeClaim(value.scope);
  if (!scope) return badRequest('scope must be exactly {deviceId, agentRef, profileId, profileRevision}');
  if (!plainRecord(value.source) || !exactKeys(value.source, ['revision', 'digest'])) {
    return badRequest('source must be exactly {revision, digest}');
  }
  if (!identifier(value.source.revision) || !identifier(value.source.digest)) {
    return badRequest('source.revision and source.digest must be non-empty single-line identifiers');
  }
  if (!plainRecord(value.selection) || !exactKeys(value.selection, ['model', 'options'])) {
    return badRequest('selection must be exactly {model, options}');
  }
  const model = parseModel(value.selection.model);
  const options = parseOptions(value.selection.options);
  if (!model || !options) return badRequest('selection.model / selection.options are outside the accepted shape');
  if (typeof value.permissionMode !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(value.permissionMode)) {
    return badRequest(`permissionMode must be one of ${PERMISSION_MODES.map((mode) => JSON.stringify(mode)).join(', ')}`);
  }
  const requiredToolsets = parseRequiredToolsets(value.requiredToolsets);
  if (!requiredToolsets) {
    return badRequest('requiredToolsets must be a non-empty array of distinct configured toolset ids');
  }
  const snapshot = parseSnapshot(value.snapshot);
  if (!snapshot) return badRequest('snapshot must be exactly {prompt, messages}');
  return {
    ok: true,
    request: {
      format: INPUT_PREPARATION_REQUEST_FORMAT,
      version: INPUT_PREPARATION_VERSION,
      requestId: value.requestId,
      policyRevision: value.policyRevision,
      scope,
      source: { revision: value.source.revision, digest: value.source.digest },
      selection: { model, options },
      permissionMode: value.permissionMode as PermissionMode,
      requiredToolsets: Object.freeze(requiredToolsets),
      snapshot,
    },
  };
}

/** Strict shape gate for `input_preparation.lookup`. */
export function parseInputPreparationLookupParams(value: unknown): InputPreparationLookupParamsV1 | undefined {
  if (!plainRecord(value) || !exactKeys(value, ['requestId', 'scope'])) return undefined;
  if (!identifier(value.requestId)) return undefined;
  const scope = parseScopeClaim(value.scope);
  if (!scope) return undefined;
  return { requestId: value.requestId, scope };
}

/** Strict shape gate for `input_preparation.cancel`. Same two fields as lookup, and no third. */
export function parseInputPreparationCancelParams(value: unknown): InputPreparationCancelParamsV1 | undefined {
  if (!plainRecord(value) || !exactKeys(value, ['requestId', 'scope'])) return undefined;
  if (!identifier(value.requestId)) return undefined;
  const scope = parseScopeClaim(value.scope);
  if (!scope) return undefined;
  return { requestId: value.requestId, scope };
}

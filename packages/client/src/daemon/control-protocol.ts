import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { TaskState } from '@byok-sdk/protocol';
import type { ApprovalDecision, PendingApproval } from './approvals';
import type { StorageCategory } from './journal/journal';
import type { StoragePressureState } from './journal/storage-policy';
import type { OperationalHealthSnapshot } from './operational-health';

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
  pid: number;
  uptimeMs: number;
  paired: boolean;
  deviceId?: string;
  /** The connection state machine's own current value (`ws-transport.ts`'s `ConnectionState`) — e.g. `'open'`, `'degraded'` (long-poll fallback), `'revoked'`, `'closed'`, `'connecting'`. */
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

export type ShutdownReason = 'unpair' | 'operator';

export interface ShutdownParams {
  reason?: ShutdownReason;
}

export function parseShutdownParams(value: unknown): ShutdownParams {
  if (!isRecord(value)) return {};
  return value.reason === 'unpair' || value.reason === 'operator' ? { reason: value.reason } : {};
}

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AgentHomeProjectionHostRevisionSchema,
  AgentHomeProjectionPayloadSchema,
  AgentRefSchema,
  type AgentHomeProjectionOutcome,
  type AgentHomeProjectionPayload,
  type AgentRef,
  type TerminalAgentHomeProjection,
} from '@byok-sdk/protocol';
import { atomicWriteFile } from './util/atomic-write.js';
import { type ExistingAncestor, resolveExistingAncestor } from './util/existing-ancestor.js';
import { ConfiguredPathLinkError, foldNameAliases } from './util/fold-name-aliases.js';
import {
  AGENT_HOME_READER_RUN_MAX_RETAINED,
  AGENT_HOME_READER_RUNS_DIRECTORY,
  isReaderRunName,
  type AgentHomeAccessMode,
} from './agent-home-readers.js';
import {
  acquirePathMutationGate,
  PathMutationGateBusyError,
  withGateReleaseFailures,
  type PathMutationGate,
} from './util/path-mutation-gate.js';

export type { AgentRef } from '@byok-sdk/protocol';

export const AGENT_HOME_DIRECTORY = 'agents';
export const AGENT_HOME_INTERNAL_DIRECTORY = '.byok';
export const AGENT_HOME_PROJECTION_STATE_FILE = 'agent-home-projection.json';

export class AgentHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentHomeError';
  }
}

export class AgentRefValidationError extends AgentHomeError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRefValidationError';
  }
}

export class AgentHomeResolutionError extends AgentHomeError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentHomeResolutionError';
  }
}

export class AgentHomeCollisionError extends AgentHomeResolutionError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentHomeCollisionError';
  }
}

export class AgentHomeBusyError extends AgentHomeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message);
    if (options?.cause !== undefined) this.cause = options.cause;
    this.name = 'AgentHomeBusyError';
  }
}

function withHomeReleaseFailures<T>(error: T, releaseFailures: readonly unknown[]): T | Error {
  if (releaseFailures.length === 0) return error;
  if (error instanceof AgentHomeBusyError) {
    return new AgentHomeBusyError(error.message, { cause: new AggregateError([error, ...releaseFailures]) });
  }
  return withGateReleaseFailures(error, releaseFailures) as Error;
}

/**
 * A resumed reader session's run directory is gone, for example after
 * retention removed it. The SDK does not create a new directory for an old
 * session, so the offer is declined without retry.
 */
export class AgentHomeReaderRunMissingError extends AgentHomeError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentHomeReaderRunMissingError';
  }
}

/** A malformed persisted lease is integrity failure, never retryable contention. */
/** A leftover memory commit copy could not be settled. The next acquire tries again. */
export class AgentHomeCommitCopyError extends AgentHomeError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentHomeCommitCopyError';
  }
}

export class AgentHomeLeaseCorruptError extends AgentHomeResolutionError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentHomeLeaseCorruptError';
  }
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
  readonly homeIdentity: Readonly<{ dev: bigint; ino: bigint }>;
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

export function validateAgentRef(value: unknown): AgentRef {
  let candidate: AgentRef;
  try {
    candidate = AgentRefSchema.parse(value);
  } catch (error) {
    throw new AgentRefValidationError(
      `AgentRef does not match the protocol contract: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return Object.freeze({ agentId: candidate.agentId, profileRevision: candidate.profileRevision });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertAbsolutePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new AgentHomeResolutionError(`${label} must be an absolute path`);
  }
  if (/[\u0000\r\n]/u.test(value)) {
    throw new AgentHomeResolutionError(`${label} must not contain NUL or line breaks`);
  }
}

async function requireExistingAncestor(inputPath: string): Promise<ExistingAncestor> {
  const ancestor = await resolveExistingAncestor(inputPath);
  if (!ancestor) throw new AgentHomeResolutionError(`no existing ancestor for ${inputPath}`);
  return ancestor;
}

async function canonicalPath(inputPath: string): Promise<string> {
  const { canonical, tail } = await requireExistingAncestor(inputPath);
  return path.resolve(canonical, ...tail);
}

/**
 * Non-mutating counterpart to the per-component check in
 * {@link ensureDirectoryNoSymlink}: a component that does not exist yet is
 * fine, but one that exists must already be a real directory. Rejects with the
 * exact message shape `resolve()` uses so both derivations fail identically.
 */
async function assertRealDirectoryIfPresent(target: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentHomeResolutionError(`Agent home path component is not a real directory: ${target}`);
  }
}

const LEASE_TEMP = /^agent-home\.lease\.\d+-\d+\.tmp$/u;
let leaseTempSeq = 0;

/** A complete, synced copy of the marker beside the lease path. */
async function writeLeaseTemp(lockPath: string, body: string): Promise<string> {
  const temp = `${lockPath}.${process.pid}-${leaseTempSeq++}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  return temp;
}

/**
 * Lease temp files of an acquire that was killed. Every acquire of this
 * home holds the agent-home-root gate across processes, so under it no
 * other write of such a file is running. Best effort: one that cannot be
 * removed now goes on the next acquire.
 */
async function removeLeaseTemps(internalDir: string): Promise<void> {
  for (const entry of await fs.readdir(internalDir)) {
    if (!LEASE_TEMP.test(entry)) continue;
    const file = path.join(internalDir, entry);
    if ((await fs.lstat(file).catch(() => undefined))?.isFile()) await fs.unlink(file).catch(() => {});
  }
}

/**
 * A filesystem that cannot hold the lease, because it has no hard links.
 * On Windows, libuv maps ERROR_ACCESS_DENIED to EPERM, which also covers a
 * delete-pending marker and an ACL refusal, so there EPERM is thrown as is.
 */
function linkUnsupported(code: string | undefined): boolean {
  if (code === 'EPERM') return process.platform !== 'win32';
  return code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS';
}

/** False when `target` exists. A filesystem without hard links fails closed. */
async function linkExclusive(source: string, target: string): Promise<boolean> {
  try {
    await fs.link(source, target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (linkUnsupported(code)) {
      throw new AgentHomeError(`Agent home lease needs a hard link in ${path.dirname(target)}, which its filesystem refused (${code})`);
    }
    throw error;
  }
}

/** Establish each directory entry before a child or ledger can depend on it. */
async function syncDirectoryParent(directory: string): Promise<void> {
  // Node has no Windows directory flush. Windows intents remain unavailable.
  // Darwin also runs the helper's strict full-sync chain before each open.
  if (process.platform === 'win32') return;
  const parent = await fs.open(path.dirname(directory), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

/** Retry barriers for ancestors that may be visible after a failed creation. */
async function syncExistingDirectoryChain(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const device = (await fs.stat(directory, { bigint: true })).dev;
  const chain: string[] = [];
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    const parent = path.dirname(cursor);
    if ((await fs.stat(parent, { bigint: true })).dev !== device) break;
    chain.unshift(cursor);
    if (parent === cursor) break;
  }
  for (const entry of chain) await syncDirectoryParent(entry);
}

// A concurrent first creator may win the mkdir: accept EEXIST only for a real directory.
async function mkdirOrAcceptRacedDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new AgentHomeResolutionError(`Agent home path component is not a real directory: ${directory}`);
    }
  }
}

async function materializeDirectory(inputPath: string): Promise<string> {
  const { canonical, tail } = await requireExistingAncestor(inputPath);
  await syncExistingDirectoryChain(canonical);
  let cursor = canonical;
  for (const component of tail) {
    cursor = path.join(cursor, component);
    try {
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new AgentHomeResolutionError(`Agent home path component is not a real directory: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdirOrAcceptRacedDirectory(cursor);
    }
    // Repeat the barrier for an existing entry. A prior attempt may have
    // created it and then failed to sync its parent.
    await syncDirectoryParent(cursor);
  }
  const realized = await fs.realpath(inputPath);
  if (realized !== cursor) {
    throw new AgentHomeResolutionError(`Agent home path changed through a symlink while being created: ${inputPath}`);
  }
  return realized;
}

export async function ensureDirectoryNoSymlink(root: string, target: string): Promise<string> {
  if (!isWithin(root, target)) throw new AgentHomeResolutionError('Agent home is outside hostStorageRoot');
  const relative = path.relative(root, target);
  const components = relative === '' ? [] : relative.split(path.sep);
  let cursor = root;
  for (const component of components) {
    cursor = path.join(cursor, component);
    try {
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new AgentHomeResolutionError(`Agent home path component is not a real directory: ${cursor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdirOrAcceptRacedDirectory(cursor);
    }
    // Repeat the barrier for an existing entry. A prior attempt may have
    // created it and then failed to sync its parent.
    await syncDirectoryParent(cursor);
  }
  const realized = await fs.realpath(target);
  if (!isWithin(root, realized) || realized !== target) {
    throw new AgentHomeResolutionError('Agent home changed through a symlink while it was being prepared');
  }
  return realized;
}

async function ensurePreservedFile(filePath: string): Promise<void> {
  try {
    const handle = await fs.open(filePath, 'wx', 0o600);
    await handle.close();
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AgentHomeResolutionError(`Agent home preserved file is not a regular file: ${filePath}`);
  }
}

/**
 * SDK-owned deterministic Agent-home layout. The downstream supplies exactly
 * one absolute branded storage root; there is deliberately no host path
 * resolver and no second workspace authority.
 */
export class AgentHomeLayout {
  private readonly hostStorageRootInput: string;
  private readonly agentIdByCanonicalHome = new Map<string, string>();
  private canonicalRoot?: string;

  constructor(hostStorageRoot: string) {
    assertAbsolutePath(hostStorageRoot, 'agentHome.hostStorageRoot');
    try {
      this.hostStorageRootInput = foldNameAliases(hostStorageRoot);
    } catch (error) {
      if (error instanceof ConfiguredPathLinkError) {
        throw new AgentHomeResolutionError(`agentHome.hostStorageRoot: ${error.message}`);
      }
      throw error;
    }
  }

  /** Configured root, for read-only maintenance discovery; does not materialize a home. */
  hostRootInput(): string { return this.canonicalRoot ?? this.hostStorageRootInput; }

  async resolve(agentRefInput: AgentRef): Promise<AgentHomeResolution> {
    const gate = await this.acquireRootMutationGate();
    try {
      const agentRef = validateAgentRef(agentRefInput);
      const hostStorageRoot = await this.resolveRoot();
      const agentsRoot = await ensureDirectoryNoSymlink(
        hostStorageRoot,
        path.join(hostStorageRoot, AGENT_HOME_DIRECTORY),
      );
      const lexicalHome = path.join(agentsRoot, agentRef.agentId);
      // Materialize and verify the exact lexical Agent segment. Canonicalizing
      // first would accidentally turn an in-root `two -> one` symlink into the
      // already-valid `one` directory and bypass cross-Agent isolation.
      const canonicalHome = await ensureDirectoryNoSymlink(agentsRoot, lexicalHome);
      const priorAgentId = this.agentIdByCanonicalHome.get(canonicalHome);
      if (priorAgentId !== undefined && priorAgentId !== agentRef.agentId) {
        throw new AgentHomeCollisionError(
          `canonical Agent home ${canonicalHome} is already bound to Agent ${priorAgentId}`,
        );
      }
      this.agentIdByCanonicalHome.set(canonicalHome, agentRef.agentId);
      return Object.freeze({
        agentRef,
        hostStorageRoot,
        agentsRoot,
        homeDir: canonicalHome,
        canonicalHome,
      });
    } finally {
      await gate.release();
    }
  }

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
  async canonicalHomePath(agentRefInput: AgentRef): Promise<string> {
    const agentRef = validateAgentRef(agentRefInput);
    const hostStorageRoot = this.canonicalRoot ?? await canonicalPath(this.hostStorageRootInput);
    const agentsRoot = path.join(hostStorageRoot, AGENT_HOME_DIRECTORY);
    await assertRealDirectoryIfPresent(agentsRoot);
    const lexicalHome = path.join(agentsRoot, agentRef.agentId);
    await assertRealDirectoryIfPresent(lexicalHome);
    const canonicalHome = await canonicalPath(lexicalHome);
    if (canonicalHome === agentsRoot || !isWithin(agentsRoot, canonicalHome)) {
      throw new AgentHomeResolutionError(`Agent home resolves outside the Agent home root: ${canonicalHome}`);
    }
    return canonicalHome;
  }

  /**
   * Prove the canonical root is materializable and writable before the daemon
   * advertises Agent-home capability. No Agent identity or persistent Agent
   * file is created by this preflight.
   */
  async preflight(): Promise<void> {
    const gate = await this.acquireRootMutationGate();
    let probePath: string | undefined;
    let handle: fs.FileHandle | undefined;
    let created = false;
    try {
      const hostStorageRoot = await this.resolveRoot();
      const agentsRoot = await ensureDirectoryNoSymlink(
        hostStorageRoot,
        path.join(hostStorageRoot, AGENT_HOME_DIRECTORY),
      );
      probePath = path.join(agentsRoot, `.byok-agent-home-preflight-${randomUUID()}`);
      handle = await fs.open(probePath, 'wx', 0o600);
      created = true;
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rm(probePath);
      created = false;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (created && probePath !== undefined) await fs.rm(probePath, { force: true }).catch(() => {});
      throw new AgentHomeResolutionError(
        `agentHome.hostStorageRoot preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await gate.release();
    }
  }

  /**
   * Construction-time validation is deliberately non-mutating. The actual
   * writable preflight runs asynchronously after daemon ownership is acquired
   * and before transport/capability publication, where it can participate in
   * the cross-process relocation gate without a sync shadow lock.
   */
  preflightSync(): void {
    assertAbsolutePath(this.hostStorageRootInput, 'agentHome.hostStorageRoot');
  }

  private async resolveRoot(): Promise<string> {
    if (this.canonicalRoot !== undefined) return this.canonicalRoot;
    try {
      this.canonicalRoot = await materializeDirectory(this.hostStorageRootInput);
    } catch (error) {
      throw new AgentHomeResolutionError(
        `agentHome.hostStorageRoot is not accessible: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.canonicalRoot;
  }

  private async acquireRootMutationGate(): Promise<PathMutationGate> {
    try {
      return await acquirePathMutationGate({
        scope: 'agent-home-root',
        targetPath: path.join(this.hostStorageRootInput, AGENT_HOME_DIRECTORY),
      }, { waitMs: 1_000 });
    } catch (error) {
      if (error instanceof PathMutationGateBusyError) {
        throw new AgentHomeBusyError('Agent-home root is reserved for local-state relocation');
      }
      throw error;
    }
  }
}

export interface AgentHomeLeaseManagerOptions {
  ownerId?: string;
  /**
   * Runs after each base lease is taken and before the caller gets it. The
   * execution lease group takes one base lease, and intent, export, projection
   * and maintenance take one each, so every path into a home passes here. A
   * failure releases the lease and fails this acquire.
   */
  settleAgentMemoryCommit?: (home: Pick<AgentHomeLease, 'canonicalHome' | 'homeIdentity'>) => Promise<void>;
}

interface StoredLeaseMarker {
  readonly version: 1;
  readonly ownerId: string;
  readonly leaseId: string;
  readonly agentRef: AgentRef;
  readonly canonicalHome: string;
}

/** `storeDir` must come from `DeviceStore.resolveDir`, so every alias of a store yields one owner. */
export function stableAgentHomeOwnerId(storeDir: string, productId: string): string {
  const identity = `${path.resolve(storeDir)}\0${productId}`;
  return `store-product:${createHash('sha256').update(identity).digest('hex')}`;
}

// Fail closed: the SDK cannot tell a crash leftover from a live writer.
function corruptLeaseMarker(lockPath: string, problem: string): AgentHomeLeaseCorruptError {
  return new AgentHomeLeaseCorruptError(
    `Agent home lease marker ${lockPath} ${problem}. Confirm that no process uses this Agent home, then delete this lease marker file and retry.`,
  );
}

function parseLeaseMarker(value: string, lockPath: string): StoredLeaseMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw corruptLeaseMarker(lockPath, 'is corrupt');
  }
  if (
    typeof parsed !== 'object' || parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { ownerId?: unknown }).ownerId !== 'string' ||
    typeof (parsed as { leaseId?: unknown }).leaseId !== 'string' ||
    typeof (parsed as { canonicalHome?: unknown }).canonicalHome !== 'string' ||
    !path.isAbsolute((parsed as { canonicalHome: string }).canonicalHome)
  ) {
    throw corruptLeaseMarker(lockPath, 'has an invalid shape');
  }
  let agentRef: AgentRef;
  try {
    agentRef = validateAgentRef((parsed as { agentRef?: unknown }).agentRef);
  } catch {
    throw corruptLeaseMarker(lockPath, 'has an invalid AgentRef');
  }
  const marker = parsed as Omit<StoredLeaseMarker, 'agentRef'>;
  return { ...marker, agentRef, canonicalHome: path.resolve(marker.canonicalHome) };
}

/**
 * The process registry of base writer leases, one per canonical home. The
 * holder kind is written in the same synchronous step as the claim, so a task's
 * lease reads `execution` from its first instant, before its execution group
 * exists. `released` resolves when the entry leaves the registry.
 */
interface HeldBaseLease {
  readonly leaseId: string;
  readonly holder: 'execution' | 'standalone';
  readonly released: Promise<void>;
  readonly settle: () => void;
}

/**
 * Resolutions passed to `AgentHomeLeaseManager.acquire()` by
 * `AgentHomeExecutionLeaseManager`: their claim is an `execution` holder.
 * Module-private, so the holder kind travels with the call's own argument and
 * the public `acquire()` keeps its signature.
 */
const executionClaims = new WeakSet<AgentHomeResolution>();

function heldBaseLeases(): Map<string, HeldBaseLease> {
  return AgentHomeLeaseManager['held'];
}

function claimBaseLease(canonicalHome: string, leaseId: string, holder: HeldBaseLease['holder']): void {
  let settle!: () => void;
  const released = new Promise<void>((resolve) => { settle = resolve; });
  heldBaseLeases().set(canonicalHome, { leaseId, holder, released, settle });
}

function ownsBaseLease(canonicalHome: string, leaseId: string): boolean {
  return heldBaseLeases().get(canonicalHome)?.leaseId === leaseId;
}

/**
 * How long an execution claim waits, once, for a standalone holder of the same
 * home to release. The memory intent's last write takes the lease only after
 * the Host answered its completion, so a task the Host dispatches at once can
 * meet it at acquire time; under fsync stress that hold reached 1088 ms. 5 s
 * covers it with margin and stays far below a 60 s task deadline.
 */
const STANDALONE_HOLDER_WAIT_MS = 5_000;

/** Resolves when `released` does or after `ms`, whichever is first; leaves no timer behind. */
async function boundedWait(released: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([released, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** The only removal from the registry, so every release path resolves `released`. */
function dropBaseLease(canonicalHome: string, leaseId: string): void {
  const held = heldBaseLeases().get(canonicalHome);
  if (held?.leaseId !== leaseId) return;
  heldBaseLeases().delete(canonicalHome);
  held.settle();
}

/** One-writer lease backed by both a process registry and an exclusive marker. */
export class AgentHomeLeaseManager {
  private static readonly held = new Map<string, HeldBaseLease>();
  private readonly ownerId: string;
  private readonly settleAgentMemoryCommit: AgentHomeLeaseManagerOptions['settleAgentMemoryCommit'];

  constructor(options: AgentHomeLeaseManagerOptions = {}) {
    this.ownerId = options.ownerId ?? `process:${randomUUID()}`;
    this.settleAgentMemoryCommit = options.settleAgentMemoryCommit;
  }

  private async settleLeftoverCommitCopy(canonicalHome: string, homeIdentity: AgentHomeLease['homeIdentity']): Promise<void> {
    try {
      await this.settleAgentMemoryCommit?.({ canonicalHome, homeIdentity });
    } catch (error) {
      throw new AgentHomeCommitCopyError(`Agent home ${canonicalHome} has a memory commit copy that could not be settled: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async acquire(resolution: AgentHomeResolution): Promise<AgentHomeLease> {
    // Only `AgentHomeExecutionLeaseManager` claims as `execution`; every other
    // holder (memory intent, export, projection) is `standalone`.
    const holder: HeldBaseLease['holder'] = executionClaims.has(resolution) ? 'execution' : 'standalone';
    const { canonicalHome, agentRef } = resolution;
    const leaseId = randomUUID();
    // An execution claim that meets a standalone holder (memory intent,
    // export, projection, maintenance) waits once, bounded, for its release.
    // Execution holders are never waited on; a standalone claim fails at once.
    const current = heldBaseLeases().get(canonicalHome);
    if (current !== undefined && holder === 'execution' && current.holder === 'standalone') {
      await boundedWait(current.released, STANDALONE_HOLDER_WAIT_MS);
    }
    // Check and reserve in one synchronous step, before any later await. Two
    // acquire() calls in one process must not both pass an async filesystem
    // preflight and then misclassify the winner's marker as restart residue.
    if (heldBaseLeases().has(canonicalHome)) {
      throw new AgentHomeBusyError(`Agent home ${canonicalHome} already has a mutable writer lease`);
    }
    claimBaseLease(canonicalHome, leaseId, holder);
    let lockPath: string | undefined;
    let rootGate: PathMutationGate | undefined;
    let ownsMarker = false;
    let homeIdentity: Readonly<{ dev: bigint; ino: bigint }> | undefined;
    try {
      rootGate = await acquirePathMutationGate({
        scope: 'agent-home-root',
        targetPath: resolution.agentsRoot,
      }, { waitMs: 1_000 });
      await ensureDirectoryNoSymlink(resolution.agentsRoot, canonicalHome);
      const homeStat = await fs.stat(canonicalHome, { bigint: true });
      if (!homeStat.isDirectory()) throw new AgentHomeResolutionError(`Agent home ${canonicalHome} is not a directory`);
      homeIdentity = Object.freeze({ dev: homeStat.dev, ino: homeStat.ino });
      const internalDir = await ensureDirectoryNoSymlink(
        canonicalHome,
        path.join(canonicalHome, AGENT_HOME_INTERNAL_DIRECTORY),
      );
      lockPath = path.join(internalDir, 'agent-home.lease');
      const marker: StoredLeaseMarker = {
        version: 1,
        ownerId: this.ownerId,
        leaseId,
        agentRef,
        canonicalHome,
      };
      // The marker appears whole or not at all: a complete, synced temp file
      // is linked onto the lease path. A process killed between creating and
      // writing the marker would otherwise leave it empty, and an empty
      // marker is refused on every later acquire.
      await removeLeaseTemps(internalDir);
      const temp = await writeLeaseTemp(lockPath, JSON.stringify(marker));
      try {
        await this.linkLeaseMarker(temp, lockPath, canonicalHome, agentRef.agentId);
        ownsMarker = true;
      } finally {
        // A temp file left here goes on the next acquire; its removal must
        // not replace the outcome of the link.
        await fs.rm(temp, { force: true }).catch(() => {});
      }
      // No directory sync: the marker excludes live writers only. A process
      // crash keeps the link visible, and after a power loss no writer is
      // alive; a lost link frees the home and a revived temp file goes on the
      // next acquire.
      await rootGate.release();
      rootGate = undefined;
    } catch (error) {
      if (ownsMarker && lockPath !== undefined) await fs.rm(lockPath, { force: true }).catch(() => {});
      const releaseFailures: unknown[] = [];
      try { await rootGate?.release(); } catch (releaseError) { releaseFailures.push(releaseError); }
      dropBaseLease(canonicalHome, leaseId);
      if (error instanceof PathMutationGateBusyError) {
        throw new AgentHomeBusyError('Agent-home root is reserved for local-state relocation', releaseFailures.length ? { cause: new AggregateError([error, ...releaseFailures]) } : undefined);
      }
      if (releaseFailures.length) throw withHomeReleaseFailures(error, releaseFailures);
      if (error instanceof AgentHomeError) throw error;
      throw new AgentHomeError(`could not acquire Agent home lease: ${error instanceof Error ? error.message : String(error)}`);
    }
    const acquiredLockPath = lockPath;
    if (acquiredLockPath === undefined) throw new AgentHomeError('Agent home lease marker path was not established');
    if (homeIdentity === undefined) throw new AgentHomeError('Agent home lease identity was not established');
    let released = false;
    let releaseAttempt: Promise<void> | undefined;
    const lease: AgentHomeLease = {
      leaseId,
      agentRef,
      canonicalHome,
      cwd: canonicalHome,
      homeIdentity,
      release: () => {
        if (released) return Promise.resolve();
        if (releaseAttempt !== undefined) return releaseAttempt;
        const attempt = (async () => {
          if (!ownsBaseLease(canonicalHome, leaseId)) {
            throw new AgentHomeBusyError(`Agent home lease ${leaseId} is no longer owned by this process`);
          }
          let contents: string;
          try {
            contents = await fs.readFile(acquiredLockPath, 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              dropBaseLease(canonicalHome, leaseId);
              released = true;
              return;
            }
            throw error;
          }
          const parsed = parseLeaseMarker(contents, acquiredLockPath);
          if (parsed.leaseId !== leaseId || parsed.ownerId !== this.ownerId) {
            throw new AgentHomeBusyError(`Agent home lease marker ${acquiredLockPath} belongs to another writer`);
          }
          await fs.rm(acquiredLockPath);
          dropBaseLease(canonicalHome, leaseId);
          released = true;
        })();
        releaseAttempt = attempt.catch((error: unknown) => {
          releaseAttempt = undefined;
          // `release()` is the caller relinquishing this in-process writer.
          // Keep an unknown/other on-disk marker intact, but never let the
          // process registry outlive the failed relinquish and wedge this home
          // after the external marker is repaired or removed.
          dropBaseLease(canonicalHome, leaseId);
          released = true;
          throw error;
        });
        return releaseAttempt;
      },
    };
    try {
      await this.settleLeftoverCommitCopy(canonicalHome, homeIdentity);
    } catch (error) {
      try { await lease.release(); } catch (releaseError) { throw withHomeReleaseFailures(error, [releaseError]); }
      throw error;
    }
    return lease;
  }

  /** No AgentRef is minted: this lease owns filesystem mutation, not a product profile. */
  async acquireMaintenance(agentsRoot: string, canonicalHome: string): Promise<{ release(): Promise<void> }> {
    if (heldBaseLeases().has(canonicalHome)) throw new AgentHomeBusyError('Agent home has an active base lease');
    const leaseId = randomUUID();
    claimBaseLease(canonicalHome, leaseId, 'standalone');
    let gate: PathMutationGate | undefined;
    try {
      gate = await acquirePathMutationGate({ scope: 'agent-home-root', targetPath: agentsRoot });
      await assertRealDirectoryIfPresent(agentsRoot);
      await assertRealDirectoryIfPresent(canonicalHome);
      const stat = await fs.lstat(canonicalHome, { bigint: true });
      if (!stat.isDirectory() || await fs.realpath(canonicalHome) !== canonicalHome || path.dirname(canonicalHome) !== agentsRoot) throw new AgentHomeResolutionError('invalid maintenance home');
      await assertRealDirectoryIfPresent(path.join(canonicalHome, AGENT_HOME_INTERNAL_DIRECTORY));
      const marker = path.join(canonicalHome, AGENT_HOME_INTERNAL_DIRECTORY, 'agent-home.lease');
      const markerStat = await fs.lstat(marker).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (markerStat !== undefined) {
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new AgentHomeLeaseCorruptError('invalid maintenance lease marker');
        const prior = parseLeaseMarker(await fs.readFile(marker, 'utf8'), marker);
        if (prior.ownerId !== this.ownerId || prior.canonicalHome !== canonicalHome || prior.agentRef.agentId !== path.basename(canonicalHome)) throw new AgentHomeBusyError('Agent home belongs to another writer');
        // Same-owner crash residue is retained. The daemon already reconciled its processes.
      }
      await this.settleLeftoverCommitCopy(canonicalHome, { dev: stat.dev, ino: stat.ino });
    } catch (error) {
      const releaseFailures: unknown[] = [];
      try { await gate?.release(); } catch (releaseError) { releaseFailures.push(releaseError); }
      finally { dropBaseLease(canonicalHome, leaseId); }
      if (error instanceof PathMutationGateBusyError) throw new AgentHomeBusyError('Agent-home root is reserved for another writer', releaseFailures.length ? { cause: new AggregateError([error, ...releaseFailures]) } : undefined);
      throw withHomeReleaseFailures(error, releaseFailures);
    }
    const heldGate = gate;
    let released = false;
    return { release: async () => {
      if (released) return;
      await heldGate.release();
      dropBaseLease(canonicalHome, leaseId);
      released = true;
    } };
  }

  // Link `temp` onto `lockPath`. An existing marker refuses the link, as `wx` refused the create.
  private async linkLeaseMarker(temp: string, lockPath: string, canonicalHome: string, agentId: string): Promise<void> {
    if (await linkExclusive(temp, lockPath)) return;
    const prior = parseLeaseMarker(await fs.readFile(lockPath, 'utf8'), lockPath);
    if (prior.ownerId !== this.ownerId) {
      throw new AgentHomeBusyError(`Agent home ${prior.canonicalHome} already has a mutable writer lease`);
    }
    if (prior.canonicalHome !== canonicalHome || prior.agentRef.agentId !== agentId) {
      throw new AgentHomeBusyError(`Agent home lease marker ${lockPath} does not match its canonical Agent identity`);
    }
    // A marker owned by this daemon identity but absent from the in-process
    // registry is crash residue. DaemonOwnerLease prevents two live daemon
    // processes for the same store/product identity, so exact-owner reclaim is
    // the only permitted restart path. The owner lease alone does not prove
    // the crashed run's runtime processes are gone; daemon start does that
    // first (`daemon/owned-process-ledger.ts` `reconcile()`), refusing to start
    // while one survives, and leases are acquired only after it.
    await fs.rm(lockPath);
    if (!await linkExclusive(temp, lockPath)) {
      throw new AgentHomeBusyError(`Agent home lease ${lockPath} was concurrently reclaimed`);
    }
  }
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

interface AgentHomeExecutionEntry {
  readonly leaseId: string;
  readonly homeAccess: AgentHomeAccessMode;
  readonly cwd: string;
  writerOverlapped: boolean;
}

interface AgentHomeExecutionGroup {
  readonly manager: AgentHomeLeaseManager;
  readonly baseLease: AgentHomeLease;
  readonly agentId: string;
  readonly leasesByKey: Map<string, AgentHomeExecutionEntry>;
}

/** The run directory of one reader Attempt: a direct child of `<home>/.byok/runs/`. */
export function agentHomeReaderRunDirectory(canonicalHome: string, name: string): string {
  if (!isReaderRunName(name)) {
    throw new AgentHomeResolutionError('reader run directory name must be one plain path segment');
  }
  return path.join(canonicalHome, AGENT_HOME_INTERNAL_DIRECTORY, AGENT_HOME_READER_RUNS_DIRECTORY, name);
}

function executionKey(input: { readonly taskId: string; readonly sessionRef?: string }): string {
  const value = input.sessionRef === undefined ? input.taskId : input.sessionRef;
  const label = input.sessionRef === undefined ? 'taskId' : 'sessionRef';
  if (typeof value !== 'string' || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new AgentHomeResolutionError(`Agent execution ${label} must be a non-empty single-line string`);
  }
  return `${input.sessionRef === undefined ? 'task' : 'session'}\0${value}`;
}

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
export class AgentHomeExecutionLeaseManager {
  private static readonly groups = new Map<string, AgentHomeExecutionGroup>();
  private static readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly manager: AgentHomeLeaseManager) {}

  async acquire(
    resolution: AgentHomeResolution,
    input: {
      readonly taskId: string;
      readonly sessionRef?: string;
      readonly homeAccess?: AgentHomeAccessMode;
      /** Required for a reader: its run directory under this home. */
      readonly cwd?: string;
    },
  ): Promise<AgentHomeExecutionLease> {
    const initialKey = executionKey(input);
    const homeAccess = input.homeAccess ?? 'memory-writer';
    const cwd = homeAccess === 'memory-writer' ? resolution.canonicalHome : input.cwd;
    if (cwd === undefined || (homeAccess === 'memory-reader'
      && cwd !== agentHomeReaderRunDirectory(resolution.canonicalHome, path.basename(cwd)))) {
      throw new AgentHomeResolutionError('a reader execution lease needs a run directory under its Agent home');
    }
    return this.exclusive(resolution.canonicalHome, async () => {
      let group = AgentHomeExecutionLeaseManager.groups.get(resolution.canonicalHome);
      if (group === undefined) {
        // Set, read and cleared in one synchronous step: `acquire()` reads the
        // mark before its first await, and the finally clears it even if an
        // overridden `acquire()` throws synchronously. The promise is awaited
        // only after, so the mark never reaches a later claim.
        executionClaims.add(resolution);
        let claiming: Promise<AgentHomeLease>;
        try {
          claiming = this.manager.acquire(resolution);
        } finally {
          executionClaims.delete(resolution);
        }
        const baseLease = await claiming;
        group = {
          manager: this.manager,
          baseLease,
          agentId: resolution.agentRef.agentId,
          leasesByKey: new Map(),
        };
        AgentHomeExecutionLeaseManager.groups.set(resolution.canonicalHome, group);
      } else if (group.manager !== this.manager || group.agentId !== resolution.agentRef.agentId) {
        throw new AgentHomeBusyError(`Agent home ${resolution.canonicalHome} is active under another execution owner`);
      }
      if (group.leasesByKey.has(initialKey)) {
        throw new AgentHomeBusyError(`Agent session already has an active execution lease in ${resolution.canonicalHome}`);
      }

      const leaseId = randomUUID();
      const others = [...group.leasesByKey.values()];
      if (homeAccess === 'memory-writer') {
        for (const other of others) if (other.homeAccess === 'memory-reader') other.writerOverlapped = true;
      }
      const entry: AgentHomeExecutionEntry = {
        leaseId,
        homeAccess,
        cwd,
        writerOverlapped: homeAccess === 'memory-reader' && others.some((other) => other.homeAccess === 'memory-writer'),
      };
      group.leasesByKey.set(initialKey, entry);
      let currentKey = initialKey;
      let sessionBound = input.sessionRef !== undefined;
      let released = false;
      return Object.freeze({
        leaseId,
        agentRef: resolution.agentRef,
        canonicalHome: resolution.canonicalHome,
        cwd,
        homeAccess,
        homeIdentity: group.baseLease.homeIdentity,
        writerOverlapped: (): boolean => entry.writerOverlapped,
        bindSession: async (sessionRef: string): Promise<void> => {
          const nextKey = executionKey({ taskId: input.taskId, sessionRef });
          await this.exclusive(resolution.canonicalHome, async () => {
            if (released) throw new AgentHomeBusyError(`Agent execution lease ${leaseId} is already released`);
            const currentGroup = AgentHomeExecutionLeaseManager.groups.get(resolution.canonicalHome);
            if (currentGroup !== group || currentGroup.leasesByKey.get(currentKey) !== entry) {
              throw new AgentHomeBusyError(`Agent execution lease ${leaseId} is no longer owned by this process`);
            }
            if (nextKey === currentKey) return;
            if (sessionBound) {
              throw new AgentHomeBusyError(
                `Agent session execution lease ${leaseId} cannot rebind to a different runtime session`,
              );
            }
            if (currentGroup.leasesByKey.has(nextKey)) {
              throw new AgentHomeBusyError(`Agent session already has an active execution lease in ${resolution.canonicalHome}`);
            }
            currentGroup.leasesByKey.set(nextKey, entry);
            currentGroup.leasesByKey.delete(currentKey);
            currentKey = nextKey;
            sessionBound = true;
          });
        },
        release: async (): Promise<void> => {
          await this.exclusive(resolution.canonicalHome, async () => {
            if (released) return;
            const currentGroup = AgentHomeExecutionLeaseManager.groups.get(resolution.canonicalHome);
            if (currentGroup !== group || currentGroup.leasesByKey.get(currentKey) !== entry) {
              released = true;
              throw new AgentHomeBusyError(`Agent execution lease ${leaseId} is no longer owned by this process`);
            }
            currentGroup.leasesByKey.delete(currentKey);
            released = true;
            if (currentGroup.leasesByKey.size === 0) {
              AgentHomeExecutionLeaseManager.groups.delete(resolution.canonicalHome);
              await currentGroup.baseLease.release();
            }
          });
        },
      });
    });
  }

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
  activeAttemptCount(canonicalHome: string, homeAccess: AgentHomeAccessMode): number {
    let count = 0;
    for (const entry of AgentHomeExecutionLeaseManager.groups.get(canonicalHome)?.leasesByKey.values() ?? []) {
      if (entry.homeAccess === homeAccess) count += 1;
    }
    return count;
  }

  /** How many active reader leases of this home use `cwd` as their run directory. */
  activeReaderRunHolders(canonicalHome: string, cwd: string): number {
    let holders = 0;
    for (const entry of AgentHomeExecutionLeaseManager.groups.get(canonicalHome)?.leasesByKey.values() ?? []) {
      if (entry.homeAccess === 'memory-reader' && entry.cwd === cwd) holders += 1;
    }
    return holders;
  }

  /** Run directories that active reader Attempts of this home use; retention never removes them. */
  activeReaderRunDirectories(canonicalHome: string): ReadonlySet<string> {
    const directories = new Set<string>();
    for (const entry of AgentHomeExecutionLeaseManager.groups.get(canonicalHome)?.leasesByKey.values() ?? []) {
      if (entry.homeAccess === 'memory-reader') directories.add(entry.cwd);
    }
    return directories;
  }

  /**
   * Counts-only readback for daemon/control status. Scoped to this manager's
   * own leases, so the number describes this daemon rather than every home
   * any manager in the process happens to hold. Never exposes a home path.
   */
  activeAttemptSummary(): { readonly homes: number; readonly attempts: number; readonly readerAttempts: number } {
    let homes = 0;
    let attempts = 0;
    let readerAttempts = 0;
    for (const group of AgentHomeExecutionLeaseManager.groups.values()) {
      if (group.manager !== this.manager) continue;
      homes += 1;
      attempts += group.leasesByKey.size;
      for (const entry of group.leasesByKey.values()) if (entry.homeAccess === 'memory-reader') readerAttempts += 1;
    }
    return { homes, attempts, readerAttempts };
  }

  async mutate<T>(binding: AgentHomeExecutionBinding, operation: () => Promise<T>): Promise<T> {
    return this.exclusive(binding.resolution.canonicalHome, async () => {
      const group = AgentHomeExecutionLeaseManager.groups.get(binding.resolution.canonicalHome);
      if (group === undefined || group.manager !== this.manager
        || ![...group.leasesByKey.values()].some((entry) => entry.leaseId === binding.lease.leaseId)) {
        throw new AgentHomeBusyError('Agent execution lease does not own this home mutation');
      }
      return operation();
    });
  }

  private async exclusive<T>(canonicalHome: string, operation: () => Promise<T>): Promise<T> {
    const prior = AgentHomeExecutionLeaseManager.queues.get(canonicalHome) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    AgentHomeExecutionLeaseManager.queues.set(canonicalHome, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (AgentHomeExecutionLeaseManager.queues.get(canonicalHome) === tail) {
        AgentHomeExecutionLeaseManager.queues.delete(canonicalHome);
      }
    }
  }
}

async function initializeAgentHome(resolution: AgentHomeResolution): Promise<void> {
  await ensureDirectoryNoSymlink(
    resolution.canonicalHome,
    path.join(resolution.canonicalHome, 'notes'),
  );
  await ensurePreservedFile(path.join(resolution.canonicalHome, 'MEMORY.md'));
}

interface StoredAgentHomeProjectionState {
  readonly version: 1;
  readonly agentRef: AgentRef;
  readonly requestId: string;
  readonly projectionHash: string;
  /** Written only when the applied payload carried it; absent means 0. */
  readonly hostRevision?: number;
}

type ProjectionOrderKey = Pick<StoredAgentHomeProjectionState, 'agentRef' | 'requestId' | 'projectionHash' | 'hostRevision'>;

function projectionStatePath(resolution: AgentHomeResolution): string {
  return path.join(
    resolution.canonicalHome,
    AGENT_HOME_INTERNAL_DIRECTORY,
    AGENT_HOME_PROJECTION_STATE_FILE,
  );
}

async function readProjectionState(
  resolution: AgentHomeResolution,
): Promise<StoredAgentHomeProjectionState | undefined> {
  const filePath = projectionStatePath(resolution);
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new AgentHomeResolutionError(`Agent projection state is not a regular file: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new AgentHomeResolutionError(
      `Agent projection state is corrupt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { requestId?: unknown }).requestId !== 'string' ||
    typeof (parsed as { projectionHash?: unknown }).projectionHash !== 'string'
  ) {
    throw new AgentHomeResolutionError('Agent projection state has an invalid shape');
  }
  const candidate = parsed as Omit<StoredAgentHomeProjectionState, 'agentRef' | 'hostRevision'> & {
    agentRef?: unknown;
    hostRevision?: unknown;
  };
  if (candidate.hostRevision !== undefined && !AgentHomeProjectionHostRevisionSchema.safeParse(candidate.hostRevision).success) {
    throw new AgentHomeResolutionError('Agent projection state has an invalid shape');
  }
  const agentRef = validateAgentRef(candidate.agentRef);
  if (agentRef.agentId !== resolution.agentRef.agentId) {
    throw new AgentHomeCollisionError('Agent projection state belongs to a different Agent home');
  }
  return Object.freeze({
    version: 1,
    agentRef,
    requestId: candidate.requestId,
    projectionHash: candidate.projectionHash,
    ...(candidate.hostRevision === undefined ? {} : { hostRevision: candidate.hostRevision as number }),
  });
}

async function writeProjectionState(
  resolution: AgentHomeResolution,
  payload: ProjectionOrderKey,
): Promise<void> {
  const filePath = projectionStatePath(resolution);
  const existing = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new AgentHomeResolutionError(`Agent projection state is not a regular file: ${filePath}`);
  }
  const state: StoredAgentHomeProjectionState = {
    version: 1,
    agentRef: payload.agentRef,
    requestId: payload.requestId,
    projectionHash: payload.projectionHash,
    ...(payload.hostRevision === undefined ? {} : { hostRevision: payload.hostRevision }),
  };
  await atomicWriteFile(filePath, `${JSON.stringify(state)}\n`, { mode: 0o600, fsync: true });
}

/** Home entries that the SDK owns, compared in lower case. */
const SDK_HOME_ENTRIES = new Set([AGENT_HOME_INTERNAL_DIRECTORY, 'memory.md', 'notes']);

/**
 * One portable file name at the home root, with the same segment rules as an
 * Agent id. A temp file name of atomicWriteFile is refused too, because
 * removeDeadTempFiles can remove a file with such a name.
 */
function isHomeFileName(name: unknown): name is string {
  return typeof name === 'string' && /^[^\u0000-\u001f\u007f\\/:<>"|?*]+$/u.test(name) && !/[. ]$/u.test(name)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name) && !/\.\d+-\d+\.tmp$/iu.test(name)
    && !SDK_HOME_ENTRIES.has(name.toLowerCase());
}

/** Signal 0 only checks the process. EPERM still means that it exists. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Remove the `<name>.<pid>-<n>.tmp` files that atomicWriteFile left for
 * `name` when its process ended before the rename. The temp file of a live
 * process can belong to a running write, so it stays. Best effort: a file
 * that cannot be removed now stays for the next call.
 */
async function removeDeadTempFiles(canonicalHome: string, name: string): Promise<void> {
  for (const entry of await fs.readdir(canonicalHome)) {
    const pid = entry.startsWith(`${name}.`) ? /^(\d+)-\d+\.tmp$/u.exec(entry.slice(name.length + 1))?.[1] : undefined;
    if (pid === undefined || processAlive(Number(pid))) continue;
    const file = path.join(canonicalHome, entry);
    if ((await fs.lstat(file).catch(() => undefined))?.isFile()) await fs.unlink(file).catch(() => {});
  }
}

/**
 * The `writeHomeFile` of one projection hook call. `close()` refuses new
 * calls and waits for the started ones, so that no write lands after the
 * projection record or outside the writer lease. It throws the first failed
 * write.
 */
function homeFileWriter(canonicalHome: string) {
  const writes: Promise<void>[] = [];
  let open = true;
  return {
    write(name: string, body: string | Uint8Array): Promise<void> {
      let write: Promise<void>;
      if (!open) write = Promise.reject(new AgentHomeError('writeHomeFile is valid only while the projection hook runs'));
      else if (!isHomeFileName(name)) write = Promise.reject(new AgentHomeError(`invalid Agent home file name: ${JSON.stringify(name)}`));
      // The cleanup is best effort. Its failure does not fail the write.
      else writes.push(write = removeDeadTempFiles(canonicalHome, name).catch(() => {})
        .then(() => atomicWriteFile(path.join(canonicalHome, name), body, { mode: 0o600, fsync: true })));
      // A hook that does not await a call, a refused one too, must not crash
      // the process with an unhandled rejection. A caller that awaits the
      // call still gets the rejection, and close() still reports a failed write.
      write.catch(() => {});
      return write;
    },
    async close(): Promise<void> {
      open = false;
      for (const result of await Promise.allSettled(writes)) if (result.status === 'rejected') throw result.reason;
    },
  };
}

/** Orders projections by `(profileRevision, hostRevision)`; an absent `hostRevision` is 0. */
function compareProjectionOrder(left: ProjectionOrderKey, right: ProjectionOrderKey): -1 | 0 | 1 {
  const leftRevision = BigInt(left.agentRef.profileRevision);
  const rightRevision = BigInt(right.agentRef.profileRevision);
  if (leftRevision !== rightRevision) return leftRevision < rightRevision ? -1 : 1;
  const leftHost = left.hostRevision ?? 0;
  const rightHost = right.hostRevision ?? 0;
  return leftHost < rightHost ? -1 : leftHost > rightHost ? 1 : 0;
}

/** Coordinates SDK-owned initialization, optional projection, and the lease. */
export class AgentHomeManager {
  readonly layout: AgentHomeLayout;
  readonly projection?: AgentHomeProjection;
  readonly leaseManager: AgentHomeLeaseManager;
  readonly executionLeaseManager: AgentHomeExecutionLeaseManager;

  constructor(options: {
    hostStorageRoot: string;
    projection?: AgentHomeProjection;
    leaseManager?: AgentHomeLeaseManager;
  }) {
    this.layout = new AgentHomeLayout(options.hostStorageRoot);
    this.projection = options.projection;
    this.leaseManager = options.leaseManager ?? new AgentHomeLeaseManager();
    this.executionLeaseManager = new AgentHomeExecutionLeaseManager(this.leaseManager);
  }

  async prepare(agentRef: AgentRef): Promise<AgentHomeBinding> {
    const binding = await this.acquire(agentRef);
    try {
      await this.initialize(binding);
      return binding;
    } catch (error) {
      await binding.lease.release().catch(() => {});
      throw error;
    }
  }

  /** Validate the configured root before capability publication. */
  async preflight(): Promise<void> {
    await this.layout.preflight();
  }

  /** Synchronous construction-time preflight for strict Agent-only admission. */
  preflightSync(): void {
    this.layout.preflightSync();
  }

  /** Maintenance uses the base writer registry and holds its root gate until work settles. */
  async withIdleHomeLease(agentId: string, work: (home: string) => Promise<void>): Promise<boolean> {
    if (path.basename(agentId) !== agentId || agentId === '.' || agentId === '..') throw new AgentHomeResolutionError('invalid maintenance Agent segment');
    const agentsRoot = path.join(this.layout.hostRootInput(), AGENT_HOME_DIRECTORY);
    const home = path.join(agentsRoot, agentId);
    let lease: { release(): Promise<void> };
    try { lease = await this.leaseManager.acquireMaintenance(agentsRoot, home); }
    catch (error) { if (error instanceof AgentHomeBusyError || error instanceof AgentHomeCommitCopyError) return false; throw error; }
    try { await work(home); return true; }
    finally { await lease.release(); }
  }

  /** Resolve and lease without applying downstream projection side effects. */
  async acquire(agentRef: AgentRef): Promise<AgentHomeBinding> {
    const resolution = await this.layout.resolve(agentRef);
    const lease = await this.leaseManager.acquire(resolution);
    return Object.freeze({ resolution, lease });
  }

  /**
   * A writer runs in the canonical home. A fresh reader runs in
   * `<home>/.byok/runs/<taskId>/`. A resumed reader passes the run directory
   * its session handoff recorded, as `runDirectory`.
   */
  async acquireExecution(
    agentRef: AgentRef,
    input: {
      readonly taskId: string;
      readonly sessionRef?: string;
      readonly homeAccess?: AgentHomeAccessMode;
      readonly runDirectory?: string;
    },
  ): Promise<AgentHomeExecutionBinding> {
    const resolution = await this.layout.resolve(agentRef);
    const homeAccess = input.homeAccess ?? 'memory-writer';
    const lease = await this.executionLeaseManager.acquire(resolution, {
      taskId: input.taskId,
      ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
      homeAccess,
      ...(homeAccess === 'memory-writer' ? {} : {
        cwd: input.runDirectory ?? agentHomeReaderRunDirectory(resolution.canonicalHome, input.taskId),
      }),
    });
    return Object.freeze({ resolution, lease });
  }

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
  async prepareReaderRun(
    binding: AgentHomeExecutionBinding,
    input: { readonly fresh: boolean },
  ): Promise<void> {
    const { resolution, lease } = binding;
    if (lease.homeAccess !== 'memory-reader') throw new AgentHomeError('only a reader execution lease has a run directory');
    return this.mutateExecution(binding, async () => {
      if (!input.fresh) {
        const stat = await fs.lstat(lease.cwd).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
          throw error;
        });
        if (stat === undefined) throw new AgentHomeReaderRunMissingError('the reader run directory of this session no longer exists');
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new AgentHomeResolutionError('the reader run directory is not a real directory');
        }
        if (await fs.realpath(lease.cwd) !== lease.cwd) {
          throw new AgentHomeResolutionError('the reader run directory resolves through a symlink');
        }
        return;
      }
      const runsRoot = await ensureDirectoryNoSymlink(resolution.canonicalHome, path.dirname(lease.cwd));
      const created = await fs.mkdir(lease.cwd, { mode: 0o700 }).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return false;
        throw error;
      });
      if (!created) await this.assertReusableReaderRun(binding);
      if (await fs.realpath(lease.cwd) !== lease.cwd) {
        throw new AgentHomeResolutionError('the reader run directory changed through a symlink while it was created');
      }
      return;
    });
  }

  /** A fresh reader may reuse only a real, empty run directory that no other active reader holds. */
  private async assertReusableReaderRun(binding: AgentHomeExecutionBinding): Promise<void> {
    const { resolution, lease } = binding;
    const stat = await fs.lstat(lease.cwd);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(lease.cwd) !== lease.cwd) {
      throw new AgentHomeBusyError('the reader run directory of this task exists and is not a real directory');
    }
    if (this.executionLeaseManager.activeReaderRunHolders(resolution.canonicalHome, lease.cwd) > 1) {
      throw new AgentHomeBusyError('another active reader holds the run directory of this task');
    }
    if ((await fs.readdir(lease.cwd)).length > 0) {
      throw new AgentHomeBusyError('the reader run directory of this task exists and is not empty');
    }
  }

  /** Initialize only after any requested session exact-match has succeeded. */
  async initialize(binding: AgentHomeBinding): Promise<void> {
    await this.initializeResolved(binding.resolution, binding.lease.cwd);
  }

  /**
   * Task-free initialization for a caller already holding `binding.lease`:
   * only the SDK-owned home skeleton (`notes/`, `MEMORY.md`), exactly as
   * `project()` ensures it, and never the downstream `projection.prepare`
   * lifecycle, which belongs to task/creation time.
   */
  async initializeTaskFree(binding: AgentHomeBinding): Promise<void> {
    await initializeAgentHome(binding.resolution);
  }

  async initializeExecution(binding: AgentHomeExecutionBinding): Promise<void> {
    await this.mutateExecution(binding, () =>
      this.initializeResolved(binding.resolution, binding.lease.cwd));
  }

  /**
   * The task-free projection already applied to this home, from the SDK-owned
   * ordering record. Read it while the execution lease is held: `project()`
   * needs the same lease, so the record cannot change during the Attempt.
   */
  async readAppliedProjection(binding: AgentHomeBinding): Promise<TerminalAgentHomeProjection | undefined> {
    const state = await readProjectionState(binding.resolution);
    return state === undefined
      ? undefined
      : { profileRevision: state.agentRef.profileRevision, projectionHash: state.projectionHash };
  }

  async mutateExecution<T>(binding: AgentHomeExecutionBinding, operation: () => Promise<T>): Promise<T> {
    return this.executionLeaseManager.mutate(binding, operation);
  }

  private async initializeResolved(resolution: AgentHomeResolution, cwd: string): Promise<void> {
    await initializeAgentHome(resolution);
    const prepare = this.projection?.prepare;
    if (prepare !== undefined) await prepare({ ...resolution, cwd });
    if (await fs.realpath(resolution.homeDir) !== resolution.canonicalHome) {
      throw new AgentHomeResolutionError('Agent projection changed the canonical home path');
    }
    await initializeAgentHome(resolution);
  }

  supportsTaskFreeProjection(): boolean {
    return this.projection?.apply !== undefined;
  }

  /**
   * Apply one task-free projection under the same canonical-home writer lease
   * used by Agent execution. The host hook owns an atomic/idempotent ensure of
   * its opaque product bytes, so an exact desired-state replay invokes it again
   * before returning `idempotent`. Only a successful new-state hook followed
   * by the SDK-owned fsynced ordering record can return `applied`. The order
   * key is `(profileRevision, hostRevision)`, an absent `hostRevision` being 0:
   * a greater key applies whatever the hash, a lower one is `stale`, and an
   * equal one is `idempotent` or `conflict` by hash.
   */
  async project(input: AgentHomeProjectionPayload): Promise<AgentHomeProjectionOutcome> {
    const payload = AgentHomeProjectionPayloadSchema.parse(input);
    const binding = await this.acquire(payload.agentRef);
    try {
      const { resolution, lease } = binding;
      await initializeAgentHome(resolution);
      const applyProjection = async (): Promise<void> => {
        const apply = this.projection?.apply;
        if (apply === undefined) {
          throw new AgentHomeError('task-free Agent-home projection is not configured');
        }
        const writer = homeFileWriter(resolution.canonicalHome);
        try {
          await apply({
            ...resolution,
            cwd: lease.cwd,
            requestId: payload.requestId,
            projectionHash: payload.projectionHash,
            projection: payload.projection,
            writeHomeFile: writer.write,
          });
        } catch (error) {
          // Report the hook's own failure, after its started writes settle.
          await writer.close().catch(() => {});
          throw error;
        }
        await writer.close();
        if (await fs.realpath(resolution.homeDir) !== resolution.canonicalHome) {
          throw new AgentHomeResolutionError('Agent projection changed the canonical home path');
        }
        await initializeAgentHome(resolution);
      };
      const current = await readProjectionState(resolution);
      if (current !== undefined) {
        const order = compareProjectionOrder(payload, current);
        if (order <= 0) {
          const outcome = order < 0 ? 'stale'
            : payload.projectionHash !== current.projectionHash ? 'conflict' : 'idempotent';
          if (outcome === 'idempotent') await applyProjection();
          // A readable rename may have survived a failed fsync. Re-establish
          // the ordering barrier before acknowledging any decision based on
          // it, preserving the original request identity rather than replay's.
          await writeProjectionState(resolution, current);
          return outcome;
        }
      }

      await applyProjection();
      await writeProjectionState(resolution, payload);
      return 'applied';
    } finally {
      // A release failure is itself ack-critical: do not let the caller post a
      // completion or advance the mailbox cursor while writer ownership is
      // uncertain.
      await binding.lease.release();
    }
  }
}

export function createAgentHomeProjection(prepare: AgentHomeProjectionFunction): AgentHomeProjection {
  return Object.freeze({ prepare });
}

/**
 * Create the task-free atomic/idempotent opaque desired-state consumer.
 * Exact revision/hash delivery may invoke it again before an idempotent receipt;
 * no task-time fallback is inferred.
 */
export function createAgentHomeProjectionConsumer(apply: AgentHomeProjectionApplyFunction): AgentHomeProjection {
  return Object.freeze({ apply });
}

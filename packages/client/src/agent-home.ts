import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AgentHomeProjectionPayloadSchema,
  AgentRefSchema,
  type AgentHomeProjectionOutcome,
  type AgentHomeProjectionPayload,
  type AgentRef,
} from '@byok-sdk/protocol';
import { atomicWriteFile } from './util/atomic-write';
import {
  acquirePathMutationGate,
  PathMutationGateBusyError,
  type PathMutationGate,
} from './daemon/path-mutation-gate';

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
  constructor(message: string) {
    super(message);
    this.name = 'AgentHomeBusyError';
  }
}

/** A malformed persisted lease is integrity failure, never retryable contention. */
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
  readonly homeIdentity: Readonly<{ dev: bigint; ino: bigint }>;
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

interface ExistingAncestor {
  readonly canonical: string;
  readonly tail: readonly string[];
}

async function resolveExistingAncestor(inputPath: string): Promise<ExistingAncestor> {
  let cursor = path.resolve(inputPath);
  const tail: string[] = [];
  for (;;) {
    try {
      return { canonical: await fs.realpath(cursor), tail };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new AgentHomeResolutionError(`no existing ancestor for ${inputPath}`);
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function canonicalPath(inputPath: string): Promise<string> {
  const { canonical, tail } = await resolveExistingAncestor(inputPath);
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

async function materializeDirectory(inputPath: string): Promise<string> {
  const { canonical, tail } = await resolveExistingAncestor(inputPath);
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
      await fs.mkdir(cursor, { mode: 0o700 });
    }
  }
  const realized = await fs.realpath(inputPath);
  if (realized !== cursor) {
    throw new AgentHomeResolutionError(`Agent home path changed through a symlink while being created: ${inputPath}`);
  }
  return realized;
}

async function ensureDirectoryNoSymlink(root: string, target: string): Promise<string> {
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
      await fs.mkdir(cursor, { mode: 0o700 });
    }
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
    this.hostStorageRootInput = path.resolve(hostStorageRoot);
  }

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

interface StoredLeaseMarker {
  readonly version: 1;
  readonly ownerId: string;
  readonly leaseId: string;
  readonly agentRef: AgentRef;
  readonly canonicalHome: string;
}

export function stableAgentHomeOwnerId(storeDir: string, productId: string): string {
  const identity = `${path.resolve(storeDir)}\0${productId}`;
  return `store-product:${createHash('sha256').update(identity).digest('hex')}`;
}

function parseLeaseMarker(value: string, lockPath: string): StoredLeaseMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AgentHomeLeaseCorruptError(`Agent home lease marker ${lockPath} is corrupt`);
  }
  if (
    typeof parsed !== 'object' || parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { ownerId?: unknown }).ownerId !== 'string' ||
    typeof (parsed as { leaseId?: unknown }).leaseId !== 'string' ||
    typeof (parsed as { canonicalHome?: unknown }).canonicalHome !== 'string' ||
    !path.isAbsolute((parsed as { canonicalHome: string }).canonicalHome)
  ) {
    throw new AgentHomeLeaseCorruptError(`Agent home lease marker ${lockPath} has an invalid shape`);
  }
  let agentRef: AgentRef;
  try {
    agentRef = validateAgentRef((parsed as { agentRef?: unknown }).agentRef);
  } catch {
    throw new AgentHomeLeaseCorruptError(`Agent home lease marker ${lockPath} has an invalid AgentRef`);
  }
  const marker = parsed as Omit<StoredLeaseMarker, 'agentRef'>;
  return { ...marker, agentRef, canonicalHome: path.resolve(marker.canonicalHome) };
}

/** One-writer lease backed by both a process registry and an exclusive marker. */
export class AgentHomeLeaseManager {
  private static readonly held = new Map<string, string>();
  private readonly ownerId: string;

  constructor(options: { ownerId?: string } = {}) {
    this.ownerId = options.ownerId ?? `process:${randomUUID()}`;
  }

  async acquire(resolution: AgentHomeResolution): Promise<AgentHomeLease> {
    const { canonicalHome, agentRef } = resolution;
    const leaseId = randomUUID();
    // Reserve synchronously before the first await. Two acquire() calls in
    // one process must not both pass an async filesystem preflight and then
    // misclassify the winner's marker as restart residue.
    if (AgentHomeLeaseManager.held.has(canonicalHome)) {
      throw new AgentHomeBusyError(`Agent home ${canonicalHome} already has a mutable writer lease`);
    }
    AgentHomeLeaseManager.held.set(canonicalHome, leaseId);
    let lockPath: string | undefined;
    let handle: fs.FileHandle | undefined;
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
      handle = await this.openLeaseMarker(lockPath, canonicalHome, agentRef.agentId);
      ownsMarker = true;
      const marker: StoredLeaseMarker = {
        version: 1,
        ownerId: this.ownerId,
        leaseId,
        agentRef,
        canonicalHome,
      };
      await handle.writeFile(JSON.stringify(marker), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rootGate.release();
      rootGate = undefined;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (ownsMarker && lockPath !== undefined) await fs.rm(lockPath, { force: true }).catch(() => {});
      await rootGate?.release().catch(() => {});
      if (AgentHomeLeaseManager.held.get(canonicalHome) === leaseId) {
        AgentHomeLeaseManager.held.delete(canonicalHome);
      }
      if (error instanceof PathMutationGateBusyError) {
        throw new AgentHomeBusyError('Agent-home root is reserved for local-state relocation');
      }
      if (error instanceof AgentHomeError) throw error;
      throw new AgentHomeError(`could not acquire Agent home lease: ${error instanceof Error ? error.message : String(error)}`);
    }
    const acquiredLockPath = lockPath;
    if (acquiredLockPath === undefined) throw new AgentHomeError('Agent home lease marker path was not established');
    if (homeIdentity === undefined) throw new AgentHomeError('Agent home lease identity was not established');
    let released = false;
    let releaseAttempt: Promise<void> | undefined;
    return {
      leaseId,
      agentRef,
      canonicalHome,
      cwd: canonicalHome,
      homeIdentity,
      release: () => {
        if (released) return Promise.resolve();
        if (releaseAttempt !== undefined) return releaseAttempt;
        const attempt = (async () => {
          if (AgentHomeLeaseManager.held.get(canonicalHome) !== leaseId) {
            throw new AgentHomeBusyError(`Agent home lease ${leaseId} is no longer owned by this process`);
          }
          let contents: string;
          try {
            contents = await fs.readFile(acquiredLockPath, 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              AgentHomeLeaseManager.held.delete(canonicalHome);
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
          AgentHomeLeaseManager.held.delete(canonicalHome);
          released = true;
        })();
        releaseAttempt = attempt.catch((error: unknown) => {
          releaseAttempt = undefined;
          // `release()` is the caller relinquishing this in-process writer.
          // Keep an unknown/other on-disk marker intact, but never let the
          // process registry outlive the failed relinquish and wedge this home
          // after the external marker is repaired or removed.
          if (AgentHomeLeaseManager.held.get(canonicalHome) === leaseId) {
            AgentHomeLeaseManager.held.delete(canonicalHome);
          }
          released = true;
          throw error;
        });
        return releaseAttempt;
      },
    };
  }

  private async openLeaseMarker(lockPath: string, canonicalHome: string, agentId: string): Promise<fs.FileHandle> {
    try {
      return await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
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
    // the only permitted restart path.
    await fs.rm(lockPath);
    try {
      return await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AgentHomeBusyError(`Agent home lease ${lockPath} was concurrently reclaimed`);
      }
      throw error;
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
  /** Effective `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome` for this daemon. */
  maxConcurrentMutableSessionsPerAgentHome: number;
  /** Canonical Agent homes this daemon currently holds at least one execution lease in. */
  activeHomes: number;
  /** Total Attempts holding an execution lease across those homes. */
  activeAttempts: number;
}

interface AgentHomeExecutionGroup {
  readonly manager: AgentHomeLeaseManager;
  readonly baseLease: AgentHomeLease;
  readonly agentId: string;
  readonly leasesByKey: Map<string, string>;
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
 * {@link AgentHomeExecutionLeaseManager.activeAttemptCount} against
 * `DaemonConfig.maxConcurrentMutableSessionsPerAgentHome` (default 1).
 */
export class AgentHomeExecutionLeaseManager {
  private static readonly groups = new Map<string, AgentHomeExecutionGroup>();
  private static readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly manager: AgentHomeLeaseManager) {}

  async acquire(
    resolution: AgentHomeResolution,
    input: { readonly taskId: string; readonly sessionRef?: string },
  ): Promise<AgentHomeExecutionLease> {
    const initialKey = executionKey(input);
    return this.exclusive(resolution.canonicalHome, async () => {
      let group = AgentHomeExecutionLeaseManager.groups.get(resolution.canonicalHome);
      if (group === undefined) {
        const baseLease = await this.manager.acquire(resolution);
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
      group.leasesByKey.set(initialKey, leaseId);
      let currentKey = initialKey;
      let sessionBound = input.sessionRef !== undefined;
      let released = false;
      return Object.freeze({
        leaseId,
        agentRef: resolution.agentRef,
        canonicalHome: resolution.canonicalHome,
        cwd: resolution.canonicalHome,
        homeIdentity: group.baseLease.homeIdentity,
        bindSession: async (sessionRef: string): Promise<void> => {
          const nextKey = executionKey({ taskId: input.taskId, sessionRef });
          await this.exclusive(resolution.canonicalHome, async () => {
            if (released) throw new AgentHomeBusyError(`Agent execution lease ${leaseId} is already released`);
            const currentGroup = AgentHomeExecutionLeaseManager.groups.get(resolution.canonicalHome);
            if (currentGroup !== group || currentGroup.leasesByKey.get(currentKey) !== leaseId) {
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
            currentGroup.leasesByKey.set(nextKey, leaseId);
            currentGroup.leasesByKey.delete(currentKey);
            currentKey = nextKey;
            sessionBound = true;
          });
        },
        release: async (): Promise<void> => {
          await this.exclusive(resolution.canonicalHome, async () => {
            if (released) return;
            const currentGroup = AgentHomeExecutionLeaseManager.groups.get(resolution.canonicalHome);
            if (currentGroup !== group || currentGroup.leasesByKey.get(currentKey) !== leaseId) {
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
  activeAttemptCount(canonicalHome: string): number {
    return AgentHomeExecutionLeaseManager.groups.get(canonicalHome)?.leasesByKey.size ?? 0;
  }

  /**
   * Counts-only readback for daemon/control status. Scoped to this manager's
   * own leases, so the number describes this daemon rather than every home
   * any manager in the process happens to hold. Never exposes a home path.
   */
  activeAttemptSummary(): { readonly homes: number; readonly attempts: number } {
    let homes = 0;
    let attempts = 0;
    for (const group of AgentHomeExecutionLeaseManager.groups.values()) {
      if (group.manager !== this.manager) continue;
      homes += 1;
      attempts += group.leasesByKey.size;
    }
    return { homes, attempts };
  }

  async mutate<T>(binding: AgentHomeExecutionBinding, operation: () => Promise<T>): Promise<T> {
    return this.exclusive(binding.resolution.canonicalHome, async () => {
      const group = AgentHomeExecutionLeaseManager.groups.get(binding.resolution.canonicalHome);
      if (group === undefined || group.manager !== this.manager || ![...group.leasesByKey.values()].includes(binding.lease.leaseId)) {
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
}

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
  const candidate = parsed as Omit<StoredAgentHomeProjectionState, 'agentRef'> & { agentRef?: unknown };
  const agentRef = validateAgentRef(candidate.agentRef);
  if (agentRef.agentId !== resolution.agentRef.agentId) {
    throw new AgentHomeCollisionError('Agent projection state belongs to a different Agent home');
  }
  return Object.freeze({
    version: 1,
    agentRef,
    requestId: candidate.requestId,
    projectionHash: candidate.projectionHash,
  });
}

async function writeProjectionState(
  resolution: AgentHomeResolution,
  payload: AgentHomeProjectionPayload,
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
  };
  await atomicWriteFile(filePath, `${JSON.stringify(state)}\n`, { mode: 0o600, fsync: true });
}

function compareProjectionRevision(left: string, right: string): -1 | 0 | 1 {
  const leftRevision = BigInt(left);
  const rightRevision = BigInt(right);
  return leftRevision < rightRevision ? -1 : leftRevision > rightRevision ? 1 : 0;
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

  /** Resolve and lease without applying downstream projection side effects. */
  async acquire(agentRef: AgentRef): Promise<AgentHomeBinding> {
    const resolution = await this.layout.resolve(agentRef);
    const lease = await this.leaseManager.acquire(resolution);
    return Object.freeze({ resolution, lease });
  }

  async acquireExecution(
    agentRef: AgentRef,
    input: { readonly taskId: string; readonly sessionRef?: string },
  ): Promise<AgentHomeExecutionBinding> {
    const resolution = await this.layout.resolve(agentRef);
    const lease = await this.executionLeaseManager.acquire(resolution, input);
    return Object.freeze({ resolution, lease });
  }

  /** Initialize only after any requested session exact-match has succeeded. */
  async initialize(binding: AgentHomeBinding): Promise<void> {
    await this.initializeResolved(binding.resolution, binding.lease.cwd);
  }

  async initializeExecution(binding: AgentHomeExecutionBinding): Promise<void> {
    await this.mutateExecution(binding, () =>
      this.initializeResolved(binding.resolution, binding.lease.cwd));
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
   * by the SDK-owned fsynced ordering record can return `applied`.
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
        await apply({
          ...resolution,
          cwd: lease.cwd,
          requestId: payload.requestId,
          projectionHash: payload.projectionHash,
          projection: payload.projection,
        });
        if (await fs.realpath(resolution.homeDir) !== resolution.canonicalHome) {
          throw new AgentHomeResolutionError('Agent projection changed the canonical home path');
        }
        await initializeAgentHome(resolution);
      };
      const current = await readProjectionState(resolution);
      if (current !== undefined) {
        const order = compareProjectionRevision(
          payload.agentRef.profileRevision,
          current.agentRef.profileRevision,
        );
        if (order < 0) return 'stale';
        if (order === 0) {
          if (payload.projectionHash !== current.projectionHash) return 'conflict';
          await applyProjection();
          return 'idempotent';
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

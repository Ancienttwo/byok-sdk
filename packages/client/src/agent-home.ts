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
  release(): Promise<void>;
}

export interface AgentHomeBinding {
  readonly resolution: AgentHomeResolution;
  readonly lease: AgentHomeLease;
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
    try {
      rootGate = await acquirePathMutationGate({
        scope: 'agent-home-root',
        targetPath: resolution.agentsRoot,
      }, { waitMs: 1_000 });
      await ensureDirectoryNoSymlink(resolution.agentsRoot, canonicalHome);
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
    let released = false;
    let releaseAttempt: Promise<void> | undefined;
    return {
      leaseId,
      agentRef,
      canonicalHome,
      cwd: canonicalHome,
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

  constructor(options: {
    hostStorageRoot: string;
    projection?: AgentHomeProjection;
    leaseManager?: AgentHomeLeaseManager;
  }) {
    this.layout = new AgentHomeLayout(options.hostStorageRoot);
    this.projection = options.projection;
    this.leaseManager = options.leaseManager ?? new AgentHomeLeaseManager();
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

  /** Initialize only after any requested session exact-match has succeeded. */
  async initialize(binding: AgentHomeBinding): Promise<void> {
    const { resolution, lease } = binding;
    await initializeAgentHome(resolution);
    const prepare = this.projection?.prepare;
    if (prepare !== undefined) await prepare({ ...resolution, cwd: lease.cwd });
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

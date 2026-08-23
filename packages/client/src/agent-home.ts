import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentRefSchema, type AgentRef } from '@byok-sdk/protocol';

export type { AgentRef } from '@byok-sdk/protocol';

export const AGENT_HOME_DIRECTORY = 'agents';
export const AGENT_HOME_INTERNAL_DIRECTORY = '.byok';

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

/**
 * Optional downstream projection hook. The SDK supplies the canonical home;
 * the host supplies opaque, redacted product content and never joins
 * `agents/<agentId>` itself. The SDK does not parse the projected content.
 */
export interface AgentHomeProjection {
  prepare(input: AgentHomeProjectionInput): void | Promise<void>;
}

export type AgentHomeProjectionFunction = (input: AgentHomeProjectionInput) => void | Promise<void>;

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
  }

  /**
   * Prove the canonical root is materializable and writable before the daemon
   * advertises Agent-home capability. No Agent identity or persistent Agent
   * file is created by this preflight.
   */
  async preflight(): Promise<void> {
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
    }
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
    throw new AgentHomeBusyError(`Agent home lease marker ${lockPath} is corrupt`);
  }
  if (
    typeof parsed !== 'object' || parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { ownerId?: unknown }).ownerId !== 'string' ||
    typeof (parsed as { leaseId?: unknown }).leaseId !== 'string' ||
    typeof (parsed as { canonicalHome?: unknown }).canonicalHome !== 'string' ||
    !path.isAbsolute((parsed as { canonicalHome: string }).canonicalHome)
  ) {
    throw new AgentHomeBusyError(`Agent home lease marker ${lockPath} has an invalid shape`);
  }
  let agentRef: AgentRef;
  try {
    agentRef = validateAgentRef((parsed as { agentRef?: unknown }).agentRef);
  } catch {
    throw new AgentHomeBusyError(`Agent home lease marker ${lockPath} has an invalid AgentRef`);
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
    let ownsMarker = false;
    try {
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
    } catch (error) {
      await handle?.close().catch(() => {});
      if (ownsMarker && lockPath !== undefined) await fs.rm(lockPath, { force: true }).catch(() => {});
      if (AgentHomeLeaseManager.held.get(canonicalHome) === leaseId) {
        AgentHomeLeaseManager.held.delete(canonicalHome);
      }
      if (error instanceof AgentHomeBusyError) throw error;
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
    await this.projection?.prepare({ ...resolution, cwd: lease.cwd });
    if (await fs.realpath(resolution.homeDir) !== resolution.canonicalHome) {
      throw new AgentHomeResolutionError('Agent projection changed the canonical home path');
    }
    await initializeAgentHome(resolution);
  }
}

export function createAgentHomeProjection(prepare: AgentHomeProjectionFunction): AgentHomeProjection {
  return Object.freeze({ prepare });
}

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Opaque host-owned Agent identity. The SDK never parses profile content. */
export interface AgentRef {
  readonly agentId: string;
  readonly profileRevision: string;
}

export const AGENT_REF_MAX_BYTES = 160;
export const AGENT_PROFILE_REVISION_MAX_BYTES = 160;

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
  /** Canonical absolute path used as runtime cwd. */
  readonly homeDir: string;
  readonly canonicalHome: string;
  readonly configuredRoot: string;
}

export type AgentHomeResolverResult = string | { readonly homeDir: string };

export interface AgentHomeResolverOptions {
  readonly configuredRoot: string;
  readonly resolve: (agentRef: AgentRef) => AgentHomeResolverResult | Promise<AgentHomeResolverResult>;
}

export interface AgentHomeLifecycleInput extends AgentHomeResolution {
  readonly cwd: string;
}

export interface AgentHomeLifecycle {
  /** The host owns profile projection and initialization; this must be idempotent. */
  prepare(input: AgentHomeLifecycleInput): void | Promise<void>;
}

export type AgentHomeLifecycleFunction = (input: AgentHomeLifecycleInput) => void | Promise<void>;

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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRefValidationError('AgentRef must be an object');
  }
  const candidate = value as { agentId?: unknown; profileRevision?: unknown };
  validateAgentId(candidate.agentId);
  validateProfileRevision(candidate.profileRevision);
  return Object.freeze({ agentId: candidate.agentId, profileRevision: candidate.profileRevision });
}

export function validateAgentId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentRefValidationError('AgentRef.agentId must be a non-empty string');
  }
  if (Buffer.byteLength(value, 'utf8') > AGENT_REF_MAX_BYTES) {
    throw new AgentRefValidationError(`AgentRef.agentId exceeds ${AGENT_REF_MAX_BYTES} UTF-8 bytes`);
  }
  if (value === '.' || value === '..' || path.isAbsolute(value) || /^[A-Za-z]:/u.test(value) || /[\\/]/u.test(value)) {
    throw new AgentRefValidationError('AgentRef.agentId must be one relative path segment');
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AgentRefValidationError('AgentRef.agentId contains a control character');
  }
}

export function validateProfileRevision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentRefValidationError('AgentRef.profileRevision must be a non-empty string');
  }
  if (Buffer.byteLength(value, 'utf8') > AGENT_PROFILE_REVISION_MAX_BYTES) {
    throw new AgentRefValidationError(
      `AgentRef.profileRevision exceeds ${AGENT_PROFILE_REVISION_MAX_BYTES} UTF-8 bytes`,
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AgentRefValidationError('AgentRef.profileRevision contains a control character');
  }
}

function sameAgentRef(left: AgentRef, right: AgentRef): boolean {
  return left.agentId === right.agentId && left.profileRevision === right.profileRevision;
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

/** Wraps a host resolver with absolute-path and canonical containment checks. */
export class AgentHomeResolver {
  private readonly configuredRootInput: string;
  private readonly resolveHost: AgentHomeResolverOptions['resolve'];
  private readonly canonicalByHome = new Map<string, AgentRef>();
  private canonicalRoot?: string;

  constructor(options: AgentHomeResolverOptions) {
    assertAbsolutePath(options.configuredRoot, 'AgentHomeResolver.configuredRoot');
    this.configuredRootInput = path.resolve(options.configuredRoot);
    this.resolveHost = options.resolve;
  }

  async resolve(agentRefInput: AgentRef): Promise<AgentHomeResolution> {
    const agentRef = validateAgentRef(agentRefInput);
    const configuredRoot = await this.resolveRoot();
    let hostResult: AgentHomeResolverResult;
    try {
      hostResult = await this.resolveHost(agentRef);
    } catch (error) {
      throw new AgentHomeResolutionError(
        `host Agent home resolver failed for ${agentRef.agentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const rawHome = typeof hostResult === 'string' ? hostResult : hostResult?.homeDir;
    assertAbsolutePath(rawHome, 'host Agent home resolver result');
    const lexicalHome = path.resolve(rawHome);
    // Check the host's lexical result against the exact configured spelling
    // first (important on macOS, where os.tmpdir() commonly contains a
    // symlink), then check canonical containment below. The canonical check
    // remains the authority against symlink escapes.
    if (!isWithin(this.configuredRootInput, lexicalHome)) {
      throw new AgentHomeResolutionError('host Agent home resolver returned a path outside the configured root');
    }
    let canonicalHome: string;
    try {
      canonicalHome = await canonicalPath(lexicalHome);
    } catch (error) {
      throw new AgentHomeResolutionError(
        `host Agent home resolver returned an unreadable path: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isWithin(configuredRoot, canonicalHome)) {
      throw new AgentHomeResolutionError('host Agent home resolver returned a path whose existing ancestor escapes the configured root');
    }
    const prior = this.canonicalByHome.get(canonicalHome);
    if (prior !== undefined && !sameAgentRef(prior, agentRef)) {
      throw new AgentHomeCollisionError(
        `canonical Agent home ${canonicalHome} is already bound to AgentRef ${prior.agentId}@${prior.profileRevision}`,
      );
    }
    this.canonicalByHome.set(canonicalHome, agentRef);
    return Object.freeze({ agentRef, homeDir: canonicalHome, canonicalHome, configuredRoot });
  }

  private async resolveRoot(): Promise<string> {
    if (this.canonicalRoot !== undefined) return this.canonicalRoot;
    try {
      this.canonicalRoot = await canonicalPath(this.configuredRootInput);
    } catch (error) {
      throw new AgentHomeResolutionError(
        `configured Agent home root is not accessible: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.canonicalRoot;
  }
}

/** One-writer lease backed by both a process registry and an exclusive marker. */
export class AgentHomeLeaseManager {
  private static readonly held = new Map<string, string>();

  async acquire(resolution: AgentHomeResolution): Promise<AgentHomeLease> {
    const { canonicalHome, agentRef } = resolution;
    await ensureDirectoryNoSymlink(resolution.configuredRoot, canonicalHome);
    if (AgentHomeLeaseManager.held.has(canonicalHome)) {
      throw new AgentHomeBusyError(`Agent home ${canonicalHome} already has a mutable writer lease`);
    }
    const leaseId = crypto.randomUUID();
    const lockPath = path.join(canonicalHome, '.byok-agent-home.lease');
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AgentHomeBusyError(`Agent home ${canonicalHome} already has a mutable writer lease`);
      }
      throw new AgentHomeError(`could not acquire Agent home lease: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await handle.writeFile(JSON.stringify({ leaseId, agentRef, canonicalHome }), 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.rm(lockPath, { force: true }).catch(() => {});
      throw new AgentHomeError(`could not persist Agent home lease: ${error instanceof Error ? error.message : String(error)}`);
    }
    await handle.close();
    AgentHomeLeaseManager.held.set(canonicalHome, leaseId);
    let released = false;
    return {
      leaseId,
      agentRef,
      canonicalHome,
      cwd: canonicalHome,
      release: async () => {
        if (released) return;
        released = true;
        if (AgentHomeLeaseManager.held.get(canonicalHome) !== leaseId) {
          throw new AgentHomeBusyError(`Agent home lease ${leaseId} is no longer owned by this process`);
        }
        AgentHomeLeaseManager.held.delete(canonicalHome);
        let contents: string | undefined;
        try {
          contents = await fs.readFile(lockPath, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (contents === undefined) return;
        let parsed: { leaseId?: unknown };
        try {
          parsed = JSON.parse(contents) as { leaseId?: unknown };
        } catch {
          throw new AgentHomeBusyError(`Agent home lease marker ${lockPath} is corrupt; refusing to remove it`);
        }
        if (parsed.leaseId !== leaseId) {
          throw new AgentHomeBusyError(`Agent home lease marker ${lockPath} belongs to another writer`);
        }
        await fs.rm(lockPath);
      },
    };
  }
}

async function ensureDirectoryNoSymlink(root: string, target: string): Promise<void> {
  if (!isWithin(root, target)) throw new AgentHomeResolutionError('Agent home is outside the configured root');
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
      await fs.mkdir(cursor);
    }
  }
  if (await fs.realpath(target) !== target) {
    throw new AgentHomeResolutionError('Agent home changed through a symlink while it was being prepared');
  }
}

/** Coordinates host projection lifecycle and the exclusive mutable lease. */
export class AgentHomeManager {
  readonly resolver: AgentHomeResolver;
  readonly lifecycle: AgentHomeLifecycle;
  readonly leaseManager: AgentHomeLeaseManager;

  constructor(options: { resolver: AgentHomeResolver; lifecycle: AgentHomeLifecycle; leaseManager?: AgentHomeLeaseManager }) {
    this.resolver = options.resolver;
    this.lifecycle = options.lifecycle;
    this.leaseManager = options.leaseManager ?? new AgentHomeLeaseManager();
  }

  async prepare(agentRef: AgentRef): Promise<AgentHomeBinding> {
    const resolution = await this.resolver.resolve(agentRef);
    const lease = await this.leaseManager.acquire(resolution);
    try {
      await this.lifecycle.prepare({ ...resolution, cwd: lease.cwd });
      if (await canonicalPath(resolution.homeDir) !== resolution.canonicalHome) {
        throw new AgentHomeResolutionError('host Agent lifecycle changed the canonical home path');
      }
      return Object.freeze({ resolution, lease });
    } catch (error) {
      await lease.release().catch(() => {});
      throw error;
    }
  }
}

export function createAgentHomeLifecycle(prepare: AgentHomeLifecycleFunction): AgentHomeLifecycle {
  return Object.freeze({ prepare });
}

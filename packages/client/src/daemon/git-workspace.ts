import { execFile, type ExecFileException } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface GitWorkspaceConfig {
  mode: 'local-checkpoints';
}

export type GitErrorCategory =
  | 'git-unavailable'
  | 'git-timeout'
  | 'git-output-limit'
  | 'git-command-failed'
  | 'workspace-root-invalid'
  | 'workspace-root-conflict'
  | 'workspace-not-owned'
  | 'repository-root-mismatch'
  | 'repository-invalid'
  | 'lease-busy'
  | 'ledger-invalid';

export class GitWorkspaceError extends Error {
  constructor(
    public readonly category: GitErrorCategory,
    message: string = category,
  ) {
    super(message);
    this.name = 'GitWorkspaceError';
  }
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

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const OWNER_MARKER = '.byok-git-workspace-owner.json';
const GIT_ENV_KEYS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_OBJECT_DIRECTORY_RELATIVE',
  'GIT_INDEX_FILE',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_NAMESPACE',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_TEMPLATE_DIR',
]);

function gitEnvironment(readOnly: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (GIT_ENV_KEYS.has(normalizedKey) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(normalizedKey) || normalizedKey === 'GIT_OPTIONAL_LOCKS') delete env[key];
  }
  if (readOnly) env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

export function stableGitWorkspaceOwnerId(storeDir: string, productId: string): string {
  const identity = `${path.resolve(storeDir)}\\0${productId}`;
  return `store-product:${createHash('sha256').update(identity).digest('hex')}`;
}
const GUIDANCE = [
  'Work only in the provided workspace directory.',
  'Inspect git status before and after edits.',
  'When Git identity is already configured, create small ordinary checkpoint commits after coherent, verified units.',
  'Do not change Git identity.',
  'Do not push, merge, rebase, stash, reset, clean, switch branches, or delete work.',
  'Leave incomplete work visible for recovery.',
].join('\n');

function canonical(value: string): string {
  return path.resolve(value);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function bounded(value: string, max: number): string {
  return Buffer.byteLength(value, 'utf8') <= max ? value : value.slice(0, max);
}

function stableFailure(result: GitCommandResult, args: readonly string[]): GitWorkspaceError {
  if (result.code === 124) return new GitWorkspaceError('git-timeout');
  const command = args[0] === '--version' ? 'preflight' : args[0] === 'init' ? 'init' : 'observation';
  return new GitWorkspaceError('git-command-failed', `Git ${command} failed`);
}

/** A bounded, no-shell runner for the small Git command allowlist. */
export const defaultGitRunner: GitRunner = (args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile('git', [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_OUTPUT_BYTES,
      windowsHide: true,
    }, (error: ExecFileException | null, stdout: string, stderr: string) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: bounded(stdout, options.maxBuffer ?? DEFAULT_MAX_OUTPUT_BYTES),
        stderr: bounded(stderr, options.maxBuffer ?? DEFAULT_MAX_OUTPUT_BYTES),
      });
    });
  });

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

interface OwnerMarker {
  version: 1;
  ownerId: string;
}

const workspaceLeases = new Map<string, GitWorkspaceLease>();
const sessionLeases = new Map<string, GitWorkspaceLease>();

function parseHead(stdout: string): string | undefined {
  const value = stdout.trim();
  return value && /^[0-9a-f]{4,128}$/i.test(value) ? value : undefined;
}

function parsePorcelain(value: string): Pick<GitWorkspaceObservation, 'staged' | 'unstaged' | 'untracked' | 'conflicted'> {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  const entries = value.split('\0');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const x = entry[0] ?? ' ';
    const y = entry[1] ?? ' ';
    if (x === '?' && y === '?') {
      untracked++;
    } else {
      if (x !== ' ') staged++;
      if (y !== ' ') unstaged++;
      if (x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A')) conflicted++;
    }
    // Porcelain v1 -z emits a second, NUL-delimited pathname for renames
    // and copies. It is data belonging to this entry, never another status.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') index += 1;
  }
  return { staged, unstaged, untracked, conflicted };
}

function asGitError(error: unknown, category: GitErrorCategory, message: string): GitWorkspaceError {
  if (error instanceof GitWorkspaceError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ETIMEDOUT' || (error as { killed?: boolean }).killed) return new GitWorkspaceError('git-timeout');
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new GitWorkspaceError('git-output-limit');
  return new GitWorkspaceError(category, message);
}

/** Local Git checkpoint manager. It never invokes a shell or mutating Git command other than init. */
export class GitWorkspaceManager {
  readonly workspaceRoot: string;
  readonly ownerId: string;
  private readonly run: GitRunner;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly platform: NodeJS.Platform;

  constructor(workspaceRoot: string, options: GitWorkspaceOptions = {}) {
    this.workspaceRoot = canonical(workspaceRoot);
    this.ownerId = options.ownerId ?? stableGitWorkspaceOwnerId(this.workspaceRoot, this.workspaceRoot);
    this.run = options.run ?? defaultGitRunner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.platform = options.platform ?? process.platform;
  }

  static validateConfig(value: unknown): GitWorkspaceConfig | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new GitWorkspaceError('workspace-root-invalid', 'gitWorkspace must be an object');
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.mode !== 'local-checkpoints' || Object.keys(candidate).some((key) => key !== 'mode')) {
      throw new GitWorkspaceError('workspace-root-invalid', 'gitWorkspace.mode must be local-checkpoints');
    }
    return { mode: 'local-checkpoints' };
  }

  async preflight(): Promise<void> {
    try {
      const result = await this.run(['--version'], this.commandOptions(undefined, true));
      if (result.code !== 0) throw stableFailure(result, ['--version']);
    } catch (error) {
      if (error instanceof GitWorkspaceError) throw error;
      throw asGitError(error, 'git-unavailable', 'Git is unavailable');
    }
    await fs.mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 }).catch(() => {
      throw new GitWorkspaceError('workspace-root-invalid', 'workspace root is unavailable');
    });
    await this.ensureOwnerMarker();
  }

  async ensureOwnerMarker(): Promise<void> {
    const markerPath = path.join(this.workspaceRoot, OWNER_MARKER);
    let existing: OwnerMarker | undefined;
    try {
      existing = JSON.parse(await fs.readFile(markerPath, 'utf8')) as OwnerMarker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new GitWorkspaceError('workspace-root-conflict', 'workspace root owner marker is invalid');
      }
    }
    if (existing && existing.version === 1 && existing.ownerId !== this.ownerId) {
      throw new GitWorkspaceError('workspace-root-conflict', 'workspace root is owned by another daemon');
    }
    if (existing?.ownerId === this.ownerId) return;
    const marker: OwnerMarker = { version: 1, ownerId: this.ownerId };
    try {
      await fs.writeFile(markerPath, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new GitWorkspaceError('workspace-root-invalid', 'workspace root owner marker cannot be created');
      }
      let competing: OwnerMarker;
      try {
        competing = JSON.parse(await fs.readFile(markerPath, 'utf8')) as OwnerMarker;
      } catch {
        throw new GitWorkspaceError('workspace-root-conflict', 'workspace root owner marker is invalid');
      }
      if (competing.ownerId !== this.ownerId) throw new GitWorkspaceError('workspace-root-conflict', 'workspace root is owned by another daemon');
    }
  }

  async prepareFresh(workspaceDir: string): Promise<GitWorkspaceObservation> {
    const root = await this.assertTaskRoot(workspaceDir);
    let result: GitCommandResult;
    try {
      result = await this.run(['init'], this.commandOptions(root, false));
    } catch {
      throw new GitWorkspaceError('git-command-failed', 'Git initialization failed');
    }
    if (result.code !== 0) throw stableFailure(result, ['init']);
    const actual = await this.readTopLevel(root);
    if (actual !== root) throw new GitWorkspaceError('repository-root-mismatch', 'Git repository root does not match workspace');
    return this.observe(root);
  }

  /** Validate an already prepared repository without creating directories or running mutating Git commands. */
  async validateExisting(workspaceDir: string): Promise<GitWorkspaceObservation> {
    const root = await this.assertExistingTaskRoot(workspaceDir);
    const actual = await this.readTopLevel(root);
    if (actual !== root) throw new GitWorkspaceError('repository-root-mismatch', 'Git repository root does not match workspace');
    return this.observe(root);
  }

  async observe(workspaceDir: string, baseline?: string): Promise<GitWorkspaceObservation> {
    const root = await this.assertTaskRoot(workspaceDir);
    const actual = await this.readTopLevel(root);
    if (actual !== root) throw new GitWorkspaceError('repository-root-mismatch', 'Git repository root does not match workspace');
    const [headResult, statusResult] = await Promise.all([
      this.read(['rev-parse', '--verify', 'HEAD'], root),
      this.read(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root),
    ]);
    const head = headResult.code === 0 ? parseHead(headResult.stdout) : undefined;
    if (headResult.code === 0 && !head) throw new GitWorkspaceError('repository-invalid', 'Git HEAD is invalid');
    if (statusResult.code !== 0) throw stableFailure(statusResult, ['status']);
    let commitsSinceBaseline = 0;
    if (head) {
      const count = await this.read(baseline ? ['rev-list', '--count', `${baseline}..HEAD`] : ['rev-list', '--count', 'HEAD'], root);
      if (count.code !== 0) throw stableFailure(count, ['rev-list']);
      commitsSinceBaseline = Number.parseInt(count.stdout.trim(), 10);
      if (!Number.isSafeInteger(commitsSinceBaseline) || commitsSinceBaseline < 0) throw new GitWorkspaceError('repository-invalid', 'Git commit count is invalid');
    }
    const dirty = parsePorcelain(statusResult.stdout);
    return {
      workspaceDir: root,
      head,
      baseline,
      headChanged: Boolean(head && baseline && head !== baseline),
      commitsSinceBaseline,
      ...dirty,
    };
  }

  async acquireLease(workspaceDir: string, sessionRef?: string): Promise<GitWorkspaceLease> {
    const root = canonical(workspaceDir);
    const existingWorkspace = workspaceLeases.get(root);
    const existingSession = sessionRef ? sessionLeases.get(sessionRef) : undefined;
    if (existingWorkspace || existingSession) throw new GitWorkspaceError('lease-busy', 'workspace is busy');
    let released = false;
    const lease: GitWorkspaceLease = {
      workspaceDir: root,
      sessionRef,
      release: () => {
        if (released) return;
        released = true;
        if (workspaceLeases.get(root) === lease) workspaceLeases.delete(root);
        if (sessionRef && sessionLeases.get(sessionRef) === lease) sessionLeases.delete(sessionRef);
      },
    };
    workspaceLeases.set(root, lease);
    if (sessionRef) sessionLeases.set(sessionRef, lease);
    return lease;
  }

  static guidance(): string {
    return GUIDANCE;
  }

  static prependGuidance(instruction: string): string {
    return `${GUIDANCE}\n\n${instruction}`;
  }

  private commandOptions(cwd?: string, readOnly = false): GitCommandOptions {
    return {
      cwd,
      timeout: this.timeoutMs,
      maxBuffer: this.maxOutputBytes,
      env: gitEnvironment(readOnly),
    };
  }

  private async read(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    try {
      return await this.run(args, this.commandOptions(cwd, true));
    } catch (error) {
      throw asGitError(error, 'git-command-failed', 'Git observation failed');
    }
  }

  private async readTopLevel(root: string): Promise<string> {
    const result = await this.read(['rev-parse', '--show-toplevel'], root);
    if (result.code !== 0) throw new GitWorkspaceError('repository-invalid', 'workspace is not a Git repository');
    return canonical(result.stdout.trim());
  }

  private async assertTaskRoot(workspaceDir: string): Promise<string> {
    const candidate = canonical(workspaceDir);
    const realWorkspaceRoot = await fs.realpath(this.workspaceRoot).catch(() => {
      throw new GitWorkspaceError('workspace-root-invalid', 'workspace root is unavailable');
    });
    if (!isContained(this.workspaceRoot, candidate) && !isContained(realWorkspaceRoot, candidate)) {
      throw new GitWorkspaceError('workspace-root-invalid', 'workspace directory is invalid');
    }
    await this.assertExistingAncestry(candidate, realWorkspaceRoot);
    await fs.mkdir(candidate, { recursive: true, mode: 0o700 }).catch(() => {
      throw new GitWorkspaceError('workspace-root-invalid', 'workspace directory is unavailable');
    });
    const realCandidate = await fs.realpath(candidate).catch(() => {
      throw new GitWorkspaceError('workspace-root-invalid', 'workspace directory is unavailable');
    });
    if (!isContained(realWorkspaceRoot, realCandidate)) {
      throw new GitWorkspaceError('workspace-root-invalid', 'workspace directory is invalid');
    }
    return realCandidate;
  }

  private async assertExistingAncestry(candidate: string, realWorkspaceRoot: string): Promise<void> {
    let current = candidate;
    while (true) {
      try {
        const realCurrent = await fs.realpath(current);
        if (!isContained(realWorkspaceRoot, realCurrent)) {
          throw new GitWorkspaceError('workspace-root-invalid', 'workspace directory is invalid');
        }
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (error instanceof GitWorkspaceError || (code !== 'ENOENT' && code !== 'ENOTDIR')) {
          throw new GitWorkspaceError('workspace-root-invalid', 'workspace directory is invalid');
        }
        const parent = path.dirname(current);
        if (parent === current) {
          throw new GitWorkspaceError('workspace-root-invalid', 'workspace directory is invalid');
        }
        current = parent;
      }
    }
  }

  private async assertExistingTaskRoot(workspaceDir: string): Promise<string> {
    const candidate = canonical(workspaceDir);
    const realWorkspaceRoot = await fs.realpath(this.workspaceRoot).catch(() => {
      throw new GitWorkspaceError('workspace-root-invalid', 'workspace root is unavailable');
    });
    const realCandidate = await fs.realpath(candidate).catch(() => {
      throw new GitWorkspaceError('repository-invalid', 'workspace directory is unavailable');
    });
    if (!isContained(realWorkspaceRoot, realCandidate)) {
      throw new GitWorkspaceError('workspace-root-invalid', 'workspace directory is invalid');
    }
    return realCandidate;
  }
}

export const GIT_WORKSPACE_OWNER_MARKER = OWNER_MARKER;
export const LOCAL_GIT_WORKSPACE_GUIDANCE = GUIDANCE;
export function prependGitWorkspaceGuidance(instruction: string): string {
  return GitWorkspaceManager.prependGuidance(instruction);
}

export function isGitWorkspaceConfig(value: unknown): value is GitWorkspaceConfig {
  try {
    return GitWorkspaceManager.validateConfig(value) !== undefined;
  } catch {
    return false;
  }
}

export async function canonicalWorkspaceRoot(value: string): Promise<string> {
  return fs.realpath(value).catch(() => canonical(value));
}

export { DEFAULT_MAX_OUTPUT_BYTES as GIT_WORKSPACE_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS as GIT_WORKSPACE_TIMEOUT_MS };

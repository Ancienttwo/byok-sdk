import { randomBytes, randomUUID } from 'node:crypto';
import { acquirePathMutationGate } from '../path-mutation-gate';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RuntimeDisposalFailure } from '../../runtime-failure';
import { atomicWriteFile } from '../../util/atomic-write';
import { ensureSecureDir } from '../../util/secure-dir';

export class ScratchRootPathError extends Error {
  constructor(reason: string) {
    super(`DaemonConfig.storage.scratchRoot ${reason}`);
    this.name = 'ScratchRootPathError';
  }
}

/** Resources owned by one execution. release() is part of its disposal receipt. */
export interface ExecutionScratch {
  readonly token: string;
  readonly sdkDir: string;
  readonly runtimeDir: string;
  readonly env: Readonly<{ TMPDIR: string; TEMP: string; TMP: string }>;
  release(): Promise<void>;
}

export function validateScratchRoot(root: string): string {
  if (typeof root !== 'string' || !path.isAbsolute(root) || /[\0\r\n]/u.test(root)) throw new ScratchRootPathError('must be an absolute, single-line path');
  const resolved = path.resolve(root);
  // Reserve 16 bytes for a runtime's socket name and one terminating NUL.
  const maximum = process.platform === 'darwin' ? 104 : process.platform === 'linux' ? 108 : undefined;
  if (maximum !== undefined && Buffer.byteLength(path.join(resolved, 'exec', '0'.repeat(12), 'runtime')) + 17 > maximum) {
    throw new ScratchRootPathError('is too long for runtime Unix sockets; configure a shorter private root');
  }
  return resolved;
}

/** Reject aliases before changing permissions or deleting anything. */
export async function privateDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  let ancestor = path.parse(absolute).root;
  for (const component of absolute.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, component);
    const stat = await fs.lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat !== undefined && (!stat.isDirectory() || stat.isSymbolicLink())) throw new ScratchRootPathError('contains a non-directory or symbolic link');
  }
  await ensureSecureDir(absolute);
}

/** Internal lifecycle owner; the daemon protects it with its store lease. */
const standaloneOwner = randomUUID();
export class ScratchRoot {
  readonly root: string;
  private readonly live = new Set<string>();
  private store?: string;
  readonly clock: () => Date;
  constructor(root: string, clock: () => Date = () => new Date()) {
    this.root = validateScratchRoot(root);
    this.clock = clock;
  }
  isLive(token: string): boolean { return this.live.has(token); }
  async open(storeDir: string): Promise<void> {
    const store = await fs.realpath(storeDir);
    await this.claim({ kind: 'store', identity: store });
    this.store = store;
  }
  private async claim(owner: { kind: 'store' | 'standalone'; identity: string }): Promise<void> {
    await privateDirectory(this.root);
    const gate = await acquirePathMutationGate({ scope: 'store', targetPath: this.root }, { waitMs: 1_000 });
    try {
      const file = path.join(this.root, 'owner.json');
      const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (stat !== undefined) {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new ScratchRootPathError('has invalid ownership metadata');
        let existing: { version?: unknown; kind?: unknown; identity?: unknown };
        try { existing = JSON.parse(await fs.readFile(file, 'utf8')); }
        catch { throw new ScratchRootPathError('has malformed ownership metadata'); }
        if (existing === null || typeof existing !== 'object') throw new ScratchRootPathError('has invalid ownership metadata');
        if (existing.version !== 1 || existing.kind !== owner.kind || existing.identity !== owner.identity) throw new ScratchRootPathError('belongs to another owner');
      } else {
        // The store lease already proves ownership of its own tmp namespace.
        // An external root without provenance must be empty before it can be claimed.
        const relativeToStore = owner.kind === 'store'
          ? path.relative(owner.identity, await fs.realpath(this.root)) : undefined;
        if (relativeToStore !== undefined && (relativeToStore === '' || relativeToStore === '..'
          || relativeToStore.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToStore))) {
          const directory = await fs.opendir(this.root);
          try { if (await directory.read() !== null) throw new ScratchRootPathError('contains unowned artifacts'); }
          finally { await directory.close(); }
        }
        await atomicWriteFile(file, JSON.stringify({ version: 1, ...owner }), { mode: 0o600, fsync: true });
      }
    } finally { await gate.release(); }
  }
  abandon(token: string): void { this.live.delete(token); }
  async create(): Promise<ExecutionScratch> {
    await this.claim(this.store === undefined ? { kind: 'standalone', identity: standaloneOwner } : { kind: 'store', identity: this.store });
    await privateDirectory(path.join(this.root, 'exec'));
    const token = randomBytes(6).toString('hex');
    const directory = path.join(this.root, 'exec', token);
    await fs.mkdir(directory, { mode: 0o700 });
    this.live.add(token);
    const sdkDir = path.join(directory, 'sdk');
    const runtimeDir = path.join(directory, 'runtime');
    try {
      await fs.mkdir(sdkDir, { mode: 0o700 });
      await fs.mkdir(runtimeDir, { mode: 0o700 });
    } catch (error) {
      this.live.delete(token);
      throw error;
    }
    let released = false;
    let inFlight: Promise<void> | undefined;
    const release = (): Promise<void> => {
      if (released) return Promise.resolve();
      return inFlight ??= (async () => {
        try {
          await privateDirectory(directory);
          await fs.rm(sdkDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
          await atomicWriteFile(path.join(directory, 'released'), this.clock().toISOString(), { mode: 0o600, fsync: true });
          released = true;
          this.live.delete(token);
        } catch (cause) {
          throw new RuntimeDisposalFailure({ stage: 'cleanup', reason: 'execution scratch disposal did not complete' }, { cause });
        }
      })().finally(() => { inFlight = undefined; });
    };
    return Object.freeze({ token, sdkDir, runtimeDir, env: Object.freeze({ TMPDIR: runtimeDir, TEMP: runtimeDir, TMP: runtimeDir }), release });
  }
}

/** Standalone adapter Hosts own this root exclusively and await release(). */
export function createExecutionScratch(options: { root: string; clock?: () => Date }): Promise<ExecutionScratch> {
  return new ScratchRoot(options.root, options.clock).create();
}

export async function createDaemonScratch(storeDir: string, kind: 'diag' | 'credential' | 'prepare'): Promise<string> {
  const root = path.join(storeDir, 'tmp', 'daemon');
  await privateDirectory(root);
  return fs.mkdtemp(path.join(root, `${kind}-`));
}

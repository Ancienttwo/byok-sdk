import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { ensureSecureDir } from '../util/secure-dir';

export type PathMutationGateScope = 'store' | 'agent-home-root';

export interface PathMutationGateInput {
  readonly scope: PathMutationGateScope;
  readonly targetPath: string;
}

export interface PathMutationGateAcquireOptions {
  /** Bounded wait for another conforming short-lived writer; relocation uses zero. */
  readonly waitMs?: number;
}

export interface PathMutationGate {
  readonly scope: PathMutationGateScope;
  readonly targetPath: string;
  readonly identity: string;
  release(): Promise<void>;
}

export class PathMutationGateBusyError extends Error {
  constructor(
    public readonly scope: PathMutationGateScope,
    public readonly targetPath: string,
  ) {
    super(`${scope} mutation gate is already held for ${targetPath}`);
    this.name = 'PathMutationGateBusyError';
  }
}

const GATE_PROTOCOL_PREFIX = 'byok-path-mutation-v1:';
const GATE_PROBE_TIMEOUT_MS = 1_000;
// Fixed and environment-independent; short enough for macOS's 104-byte
// sockaddr_un limit even when the full SHA-256 identity is used.
const POSIX_GATE_ROOT = `/tmp/byok-pm-${process.getuid?.() ?? 'unknown'}`;

function assertAbsolutePath(value: string): void {
  if (!path.isAbsolute(value)) throw new Error('path mutation gate target must be absolute');
  if (/[\x00\r\n]/u.test(value)) throw new Error('path mutation gate target must not contain NUL or line breaks');
}

/** Canonicalize through the deepest existing ancestor without creating the target. */
export async function resolvePathWithoutCreate(input: string): Promise<string> {
  assertAbsolutePath(input);
  let cursor = path.resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.resolve(await fs.realpath(cursor), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`no existing ancestor for ${input}`);
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function gateIdentity(scope: PathMutationGateScope, canonicalTarget: string): string {
  return createHash('sha256').update(`${scope}\0${canonicalTarget}`).digest('hex');
}

function gateEndpoint(identity: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\byok-path-mutation-${identity}`;
  return path.join(POSIX_GATE_ROOT, `${identity}.sock`);
}

function endProbe(socket: Socket, identity: string): void {
  socket.on('error', () => {});
  socket.end(`${GATE_PROTOCOL_PREFIX}${identity}\n`);
}

type GateProbe = 'unbound' | 'holder' | 'occupied';

async function probeEndpoint(endpoint: string, identity: string): Promise<GateProbe> {
  return new Promise<GateProbe>((resolve) => {
    const socket = createConnection(endpoint);
    let settled = false;
    let raw = '';
    const finish = (result: GateProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('occupied'), GATE_PROBE_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > GATE_PROTOCOL_PREFIX.length + 65) finish('occupied');
    });
    socket.once('end', () => {
      finish(raw.trimEnd() === `${GATE_PROTOCOL_PREFIX}${identity}` ? 'holder' : 'occupied');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'unbound' : 'occupied');
    });
  });
}

async function assertPrivateGateRoot(): Promise<void> {
  if (process.platform === 'win32') return;
  await ensureSecureDir(POSIX_GATE_ROOT);
  const stat = await fs.lstat(POSIX_GATE_ROOT);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`path mutation gate root is not a private owned directory: ${POSIX_GATE_ROOT}`);
  }
}

async function clearProvenStaleEndpoint(
  endpoint: string,
  identity: string,
  scope: PathMutationGateScope,
  targetPath: string,
): Promise<void> {
  if (process.platform === 'win32') return;
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isSocket()) throw new Error(`path mutation gate endpoint is not a socket: ${endpoint}`);
  if ((await probeEndpoint(endpoint, identity)) !== 'unbound') {
    throw new PathMutationGateBusyError(scope, targetPath);
  }
  await fs.rm(endpoint, { force: true });
}

async function acquireOne(input: PathMutationGateInput): Promise<PathMutationGate> {
  const canonicalTarget = await resolvePathWithoutCreate(input.targetPath);
  const identity = gateIdentity(input.scope, canonicalTarget);
  const endpoint = gateEndpoint(identity);
  await assertPrivateGateRoot();
  await clearProvenStaleEndpoint(endpoint, identity, input.scope, canonicalTarget);

  const server: Server = createServer((socket) => endProbe(socket, identity));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    server.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new PathMutationGateBusyError(input.scope, canonicalTarget);
    }
    throw error;
  }
  if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600).catch(() => undefined);
  server.unref();

  try {
    const rechecked = await resolvePathWithoutCreate(input.targetPath);
    if (rechecked !== canonicalTarget) {
      throw new Error(`path mutation gate target changed during acquisition: ${input.targetPath}`);
    }
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await fs.rm(endpoint, { force: true }).catch(() => undefined);
    throw error;
  }

  let serverClosed = false;
  let released = false;
  let releaseAttempt: Promise<void> | undefined;
  return Object.freeze({
    scope: input.scope,
    targetPath: canonicalTarget,
    identity,
    release: () => {
      if (released) return Promise.resolve();
      if (releaseAttempt !== undefined) return releaseAttempt;
      releaseAttempt = (async () => {
        if (!serverClosed) {
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
          serverClosed = true;
        }
        if (process.platform !== 'win32') await fs.rm(endpoint, { force: true });
        released = true;
      })().catch((error: unknown) => {
        releaseAttempt = undefined;
        throw error;
      });
      return releaseAttempt;
    },
  });
}

/** Acquire multiple path gates in one deterministic order to prevent deadlock. */
export async function acquirePathMutationGates(inputs: readonly PathMutationGateInput[]): Promise<readonly PathMutationGate[]> {
  const resolved = await Promise.all(inputs.map(async (input) => {
    const targetPath = await resolvePathWithoutCreate(input.targetPath);
    return { ...input, targetPath, identity: gateIdentity(input.scope, targetPath) };
  }));
  const unique = [...new Map(resolved.map((item) => [`${item.scope}\0${item.targetPath}`, item])).values()]
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const acquired: PathMutationGate[] = [];
  try {
    for (const input of unique) acquired.push(await acquireOne(input));
    return Object.freeze(acquired.slice());
  } catch (error) {
    await Promise.allSettled(acquired.reverse().map((gate) => gate.release()));
    throw error;
  }
}

export async function acquirePathMutationGate(
  input: PathMutationGateInput,
  options: PathMutationGateAcquireOptions = {},
): Promise<PathMutationGate> {
  const waitMs = options.waitMs ?? 0;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) {
    throw new Error('path mutation gate waitMs must be an integer from 0 through 30000');
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await acquireOne(input);
    } catch (error) {
      if (!(error instanceof PathMutationGateBusyError) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now())));
      });
    }
  }
}

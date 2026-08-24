import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AGENT_HOME_DIRECTORY, AGENT_HOME_INTERNAL_DIRECTORY } from './agent-home';
import {
  assertDaemonStoreQuiescent,
  DaemonOwnerActiveError,
} from './daemon/daemon-owner';
import {
  acquirePathMutationGates,
  PathMutationGateBusyError,
  resolvePathWithoutCreate,
  type PathMutationGate,
} from './daemon/path-mutation-gate';

export class LocalStateRelocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalStateRelocationError';
  }
}

export class LocalStateRelocationBusyError extends LocalStateRelocationError {
  constructor(message: string) {
    super(message);
    this.name = 'LocalStateRelocationBusyError';
  }
}

export class LocalStateRelocationIntegrityError extends LocalStateRelocationError {
  constructor(message: string) {
    super(message);
    this.name = 'LocalStateRelocationIntegrityError';
  }
}

export interface LocalStateRelocationInput {
  readonly productId: string;
  readonly sourceStoreDir: string;
  readonly sourceHostStorageRoot: string;
  readonly destinationStoreDir: string;
  readonly destinationHostStorageRoot: string;
}

export interface LocalStateRelocationLease extends LocalStateRelocationInput {
  release(): Promise<void>;
}

function assertProductId(value: string): void {
  if (typeof value !== 'string' || value.trim() === '' || /[\x00\r\n]/u.test(value)) {
    throw new LocalStateRelocationIntegrityError('productId must be a non-empty string without NUL or line breaks');
  }
}

function assertAbsolutePath(value: string, label: string): void {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00\r\n]/u.test(value)) {
    throw new LocalStateRelocationIntegrityError(`${label} must be an absolute path without NUL or line breaks`);
  }
}

async function assertNoSymlinkComponents(input: string, label: string): Promise<void> {
  const resolved = path.resolve(input);
  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const component of components) {
    cursor = path.join(cursor, component);
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new LocalStateRelocationIntegrityError(`${label} contains a symlink component: ${cursor}`);
    }
    if (!stat.isDirectory()) {
      throw new LocalStateRelocationIntegrityError(`${label} contains a non-directory component: ${cursor}`);
    }
  }
}

async function assertAgentHomeRootQuiescent(hostStorageRoot: string): Promise<void> {
  const agentsRoot = path.join(hostStorageRoot, AGENT_HOME_DIRECTORY);
  let rootStat: import('node:fs').Stats;
  try {
    rootStat = await fs.lstat(agentsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new LocalStateRelocationIntegrityError(`Agent-home root is not a real directory: ${agentsRoot}`);
  }

  const entries = await fs.readdir(agentsRoot, { withFileTypes: true });
  for (const entry of entries) {
    const agentHome = path.join(agentsRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new LocalStateRelocationIntegrityError(`unexpected object in Agent-home root: ${agentHome}`);
    }
    const internalDir = path.join(agentHome, AGENT_HOME_INTERNAL_DIRECTORY);
    let internalStat: import('node:fs').Stats;
    try {
      internalStat = await fs.lstat(internalDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!internalStat.isDirectory() || internalStat.isSymbolicLink()) {
      throw new LocalStateRelocationIntegrityError(`Agent internal state is not a real directory: ${internalDir}`);
    }
    const marker = path.join(internalDir, 'agent-home.lease');
    try {
      await fs.lstat(marker);
      throw new LocalStateRelocationBusyError(`Agent home has an active or unknown writer lease: ${agentHome}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function releaseAll(gates: readonly PathMutationGate[]): Promise<void> {
  const failures: unknown[] = [];
  for (const gate of [...gates].reverse()) {
    try {
      await gate.release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'failed to release every local-state relocation gate');
}

function mapRelocationError(error: unknown): never {
  if (error instanceof LocalStateRelocationError) throw error;
  if (error instanceof PathMutationGateBusyError || error instanceof DaemonOwnerActiveError) {
    throw new LocalStateRelocationBusyError(error.message);
  }
  throw new LocalStateRelocationIntegrityError(
    `local-state relocation preflight failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function acquire(input: LocalStateRelocationInput): Promise<LocalStateRelocationLease> {
  assertProductId(input.productId);
  assertAbsolutePath(input.sourceStoreDir, 'sourceStoreDir');
  assertAbsolutePath(input.sourceHostStorageRoot, 'sourceHostStorageRoot');
  assertAbsolutePath(input.destinationStoreDir, 'destinationStoreDir');
  assertAbsolutePath(input.destinationHostStorageRoot, 'destinationHostStorageRoot');

  const requested = {
    productId: input.productId,
    sourceStoreDir: path.resolve(input.sourceStoreDir),
    sourceHostStorageRoot: path.resolve(input.sourceHostStorageRoot),
    destinationStoreDir: path.resolve(input.destinationStoreDir),
    destinationHostStorageRoot: path.resolve(input.destinationHostStorageRoot),
  };
  const canonical = {
    productId: input.productId,
    sourceStoreDir: await resolvePathWithoutCreate(input.sourceStoreDir),
    sourceHostStorageRoot: await resolvePathWithoutCreate(input.sourceHostStorageRoot),
    destinationStoreDir: await resolvePathWithoutCreate(input.destinationStoreDir),
    destinationHostStorageRoot: await resolvePathWithoutCreate(input.destinationHostStorageRoot),
  };
  if (canonical.sourceStoreDir === canonical.destinationStoreDir) {
    throw new LocalStateRelocationIntegrityError('sourceStoreDir and destinationStoreDir must be distinct');
  }
  if (canonical.sourceHostStorageRoot === canonical.destinationHostStorageRoot) {
    throw new LocalStateRelocationIntegrityError('sourceHostStorageRoot and destinationHostStorageRoot must be distinct');
  }

  for (const [label, value] of Object.entries(canonical)) {
    if (label !== 'productId') await assertNoSymlinkComponents(value, label);
  }

  let gates: readonly PathMutationGate[] | undefined;
  try {
    gates = await acquirePathMutationGates([
      { scope: 'store', targetPath: canonical.sourceStoreDir },
      { scope: 'store', targetPath: canonical.destinationStoreDir },
      { scope: 'agent-home-root', targetPath: path.join(canonical.sourceHostStorageRoot, AGENT_HOME_DIRECTORY) },
      { scope: 'agent-home-root', targetPath: path.join(canonical.destinationHostStorageRoot, AGENT_HOME_DIRECTORY) },
    ]);

    for (const [label, value] of Object.entries(canonical)) {
      if (label !== 'productId') await assertNoSymlinkComponents(value, label);
    }
    await assertDaemonStoreQuiescent(canonical.sourceStoreDir);
    await assertDaemonStoreQuiescent(canonical.destinationStoreDir);
    await assertAgentHomeRootQuiescent(canonical.sourceHostStorageRoot);
    await assertAgentHomeRootQuiescent(canonical.destinationHostStorageRoot);
  } catch (error) {
    if (gates !== undefined) {
      try {
        await releaseAll(gates);
      } catch (releaseError) {
        throw new LocalStateRelocationIntegrityError(
          `local-state relocation refusal also failed to release every gate: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        );
      }
    }
    mapRelocationError(error);
  }

  const acquiredGates = gates;
  if (acquiredGates === undefined) {
    throw new LocalStateRelocationIntegrityError('local-state relocation gates were not established');
  }
  let released = false;
  let releaseAttempt: Promise<void> | undefined;
  return Object.freeze({
    ...requested,
    release: () => {
      if (released) return Promise.resolve();
      if (releaseAttempt !== undefined) return releaseAttempt;
      releaseAttempt = releaseAll(acquiredGates)
        .then(() => {
          released = true;
        })
        .catch((error: unknown) => {
          releaseAttempt = undefined;
          throw error;
        });
      return releaseAttempt;
    },
  });
}

export const localStateRelocation = Object.freeze({ acquire });

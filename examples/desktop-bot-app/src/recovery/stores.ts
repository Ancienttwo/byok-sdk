/**
 * Where the stores live and how a recovery action moves them (#1499 D3, D4;
 * #1917). File system only, no SDK code: main runs restore, the Host executable
 * runs start fresh (`src/host/recovery.ts`). Nothing here deletes a store. A
 * store that gives way is renamed beside itself, and a failed action renames
 * every store it moved back.
 */
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stampOf } from './protocol.ts';
import type { Move } from './types.ts';

export { stampOf, type Move };

/** The `resolveHostLayout` paths the stores live under. */
export interface StoreLayout {
  readonly storeDir: string;
  readonly scratchRoot: { readonly path: string };
  readonly hostStorageRoot: string;
}

/** Written last into a snapshot; a snapshot without it is partial and is never restored. */
const COMPLETE_MARKER = 'complete.json';

export const hostStoresDir = (layout: StoreLayout): string => path.join(layout.hostStorageRoot, 'host');
export const agentHomesDir = (layout: Pick<StoreLayout, 'hostStorageRoot'>): string => path.join(layout.hostStorageRoot, 'agents');
export const snapshotsDir = (layout: StoreLayout): string => path.join(hostStoresDir(layout), 'snapshots');

/** Marks the snapshot in `target` complete, after every store in it was copied. */
export async function markSnapshotComplete(target: string, version: string): Promise<void> {
  await writeFile(path.join(target, COMPLETE_MARKER), `${JSON.stringify({ version })}\n`, { flag: 'wx', mode: 0o600 });
}

/** The snapshot directory of `version` when its marker names that version; undefined for a missing or partial one. */
export async function completeSnapshot(layout: StoreLayout, version: string): Promise<string | undefined> {
  const directory = path.join(snapshotsDir(layout), version);
  let text: string;
  try {
    text = await readFile(path.join(directory, COMPLETE_MARKER), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return (JSON.parse(text) as { version?: unknown }).version === version ? directory : undefined;
}

/** Only ENOENT means absent; access and other inspection errors must refuse recovery. */
async function present(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`Cannot inspect ${file}: ${(error as Error).message}`, { cause: error });
  }
}

/** Inspects all paths before renaming existing sources; on a failure renames back what it moved and rethrows. */
export async function moveAll(moves: readonly Move[]): Promise<Move[]> {
  const planned: Move[] = [];
  for (const move of moves) {
    if (!await present(move.from)) continue;
    if (await present(move.to)) throw new Error(`${move.to} already exists`);
    planned.push(move);
  }
  const done: Move[] = [];
  try {
    for (const move of planned) {
      await rename(move.from, move.to);
      done.push(move);
    }
  } catch (error) {
    await moveBack(done, error);
  }
  return done;
}

/** A failed action whose moves could not all be undone: `stillAside` names the directories left aside. */
export class MoveBackError extends Error {
  constructor(readonly stillAside: readonly string[], cause: unknown) {
    super(`${(cause as Error).message}; could not move back: ${stillAside.join(', ')}`, { cause });
    this.name = 'MoveBackError';
  }
}

/** Renames `done` back, last first, then rethrows `cause`, or a {@link MoveBackError} when a rename back failed too. */
export async function moveBack(done: readonly Move[], cause: unknown): Promise<never> {
  const stillAside: string[] = [];
  for (const move of [...done].reverse()) {
    try {
      await rename(move.to, move.from);
    } catch (error) {
      stillAside.push(`${move.to} (${(error as Error).message})`);
    }
  }
  if (stillAside.length > 0) throw new MoveBackError(stillAside, cause);
  throw cause;
}

/**
 * Copies the stores of `version`, after the Host stopped, so a user can go back
 * to this version with the data it wrote: the SDK store directory (without its
 * scratch root) and the Host's own stores (`<hostStorageRoot>/host`). Snapshots
 * live in `<hostStorageRoot>/host/snapshots/<version>`. Each snapshot is staged
 * and marked complete in a sibling temporary directory before swapping into
 * `<version>`, so a failed retry keeps any existing complete snapshot of the
 * same version intact; superseded entries in `snapshots/` are removed only
 * after `<version>` is in place. Returns the snapshot directory.
 */
export async function snapshotStores(layout: StoreLayout, version: string): Promise<string> {
  const hostDir = hostStoresDir(layout);
  const snapshots = snapshotsDir(layout);
  const target = path.join(snapshots, version);
  await mkdir(snapshots, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(snapshots, `.${version}.staging-`));
  try {
    await cp(layout.storeDir, path.join(staging, 'store'), { recursive: true, filter: source => source !== layout.scratchRoot.path });
    // The snapshot directory is inside the directory it copies, so its entries are copied one by one, never `snapshots` itself.
    await mkdir(path.join(staging, 'host'), { mode: 0o700 });
    for (const entry of await readdir(hostDir)) {
      if (entry !== 'snapshots') await cp(path.join(hostDir, entry), path.join(staging, 'host', entry), { recursive: true });
    }
    await markSnapshotComplete(staging, version);
    const previous = path.join(snapshots, `.${version}.previous-${randomUUID()}`);
    const done = await moveAll([{ from: target, to: previous }]);
    try {
      await rename(staging, target);
    } catch (error) {
      await moveBack(done, error);
    }
  } catch (error) {
    try {
      await rm(staging, { recursive: true, force: true, maxRetries: 5 });
    } catch (cleanup) {
      throw new Error(`${(error as Error).message}; the staged snapshot could not be removed: ${(cleanup as Error).message}`, { cause: error });
    }
    throw error;
  }
  for (const entry of await readdir(snapshots)) {
    if (entry !== version) await rm(path.join(snapshots, entry), { recursive: true, force: true, maxRetries: 5 });
  }
  return target;
}

/**
 * Puts the complete snapshot of `version` in place of the current stores. The
 * snapshot is copied to staging directories first; then the current SDK store
 * and Host stores move aside, the staged copies take their places, and the
 * snapshots move into the new Host stores. A failure moves every store back and
 * removes the staged copies. Returns the Host stores' aside path.
 */
export async function restoreSnapshot(layout: StoreLayout, version: string, stamp: string): Promise<string> {
  const snapshot = await completeSnapshot(layout, version);
  if (snapshot === undefined) throw new Error(`No complete snapshot of version ${version} to restore`);
  const host = hostStoresDir(layout);
  const staged = { store: `${layout.storeDir}.restore-${stamp}`, host: `${host}.restore-${stamp}` };
  // The staged directories are this action's own copies of the snapshot, never a store: a failure removes them.
  // Retried, because Windows reports EBUSY while a scanner still holds a file just copied.
  const dropStaged = async () => {
    await rm(staged.store, { recursive: true, force: true, maxRetries: 5 });
    await rm(staged.host, { recursive: true, force: true, maxRetries: 5 });
  };
  const hostAside = `${host}.aside-${stamp}`;
  for (const dir of Object.values(staged)) if (await present(dir)) throw new Error(`${dir} already exists`);
  try {
    await cp(path.join(snapshot, 'store'), staged.store, { recursive: true, errorOnExist: true, force: false });
    await cp(path.join(snapshot, 'host'), staged.host, { recursive: true, errorOnExist: true, force: false });
    const done = await moveAll([{ from: layout.storeDir, to: `${layout.storeDir}.aside-${stamp}` }, { from: host, to: hostAside }]);
    try {
      for (const move of [{ from: staged.store, to: layout.storeDir }, { from: staged.host, to: host }, { from: path.join(hostAside, 'snapshots'), to: snapshotsDir(layout) }]) {
        await rename(move.from, move.to);
        done.push(move);
      }
    } catch (error) {
      await moveBack(done, error);
    }
  } catch (error) {
    // The action's own failure (and any store still aside) is what the user needs; a leftover staged copy is appended.
    try {
      await dropStaged();
    } catch (cleanup) {
      throw new Error(`${(error as Error).message}; the staged copy could not be removed: ${(cleanup as Error).message}`, { cause: error });
    }
    throw error;
  }
  return hostAside;
}

/** The moves of start fresh: the SDK store, the Host stores with their snapshots, and the Agent homes, each beside itself. */
export function startFreshMoves(layout: StoreLayout, stamp: string): Move[] {
  return [layout.storeDir, hostStoresDir(layout), agentHomesDir(layout)].map(from => ({ from, to: `${from}.aside-${stamp}` }));
}

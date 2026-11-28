import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { RESIDENT_MEMORY_MAX_BYTES } from '@byok-sdk/protocol/constants';
import type { BotMemory } from './types.ts';

const errnoOf = (error: unknown): string | undefined =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string' ? (error as NodeJS.ErrnoException).code : undefined;

/** A file system refusal makes the value unreadable (`null`); any other failure is a defect and propagates. */
async function readable<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (errnoOf(error) !== undefined) return null;
    throw error;
  }
}

/** The size of `MEMORY.md` against the SDK's limit. Like the device, a link or other non-regular file is not read. */
async function resident(home: string): Promise<BotMemory['resident']> {
  const stat = await lstat(path.join(home, 'MEMORY.md'));
  if (!stat.isFile()) return null;
  return { byteCount: stat.size, limitBytes: RESIDENT_MEMORY_MAX_BYTES, overLimit: stat.size > RESIDENT_MEMORY_MAX_BYTES };
}

async function notes(home: string): Promise<BotMemory['notes']> {
  const directory = path.join(home, 'notes');
  const stat = await lstat(directory).catch((error: unknown) => {
    if (errnoOf(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (stat === undefined) {
    // No `notes/` in a home that exists: the Bot wrote no notes yet. A missing home throws here and reads as unavailable.
    await lstat(home);
    return { count: 0, bytes: 0 };
  }
  if (!stat.isDirectory()) return null;
  const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
  const sizes = await Promise.all(files.map(async entry => (await lstat(path.join(entry.parentPath, entry.name))).size));
  return { count: files.length, bytes: sizes.reduce((total, size) => total + size, 0) };
}

/** Reads the memory files of the Agent home at `home`, read-only and without a lease. */
export async function readMemoryFiles(home: string): Promise<Pick<BotMemory, 'resident' | 'notes'>> {
  const [residentValue, notesValue] = await Promise.all([readable(() => resident(home)), readable(() => notes(home))]);
  return { resident: residentValue, notes: notesValue };
}

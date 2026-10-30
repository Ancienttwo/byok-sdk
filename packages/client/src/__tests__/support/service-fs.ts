import type { promises as fsp } from 'node:fs';
import { vi } from 'vitest';
import type { ManagedLifecycleFs } from '../../lifecycle/managed-lifecycle';
import { SERVICE_UNIT_MARKER } from '../../lifecycle/service-unit';

function enoent(file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
}

/** In-memory fs for the service lifecycles: every method is a spy over one `files` map. */
export function memoryServiceFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const spies = {
    files,
    readFile: vi.fn(async (file: string) => {
      const content = files.get(file);
      if (content === undefined) throw enoent(file);
      return content;
    }),
    writeFile: vi.fn(async (file: string, content: string) => { files.set(file, content); }),
    rename: vi.fn(async (from: string, to: string) => {
      const content = files.get(from);
      if (content === undefined) throw enoent(from);
      files.delete(from);
      files.set(to, content);
    }),
    rm: vi.fn(async (file: string) => { files.delete(file); }),
    mkdir: vi.fn(async () => undefined),
    chmod: vi.fn(async () => undefined),
    copyFile: vi.fn(async (from: string, to: string) => { files.set(to, files.get(from) ?? `copy of ${from}`); }),
  };
  // The spies take the subset of each fs overload the lifecycles call.
  return spies as typeof spies & ManagedLifecycleFs & Pick<typeof fsp, 'copyFile'>;
}

export type MemoryServiceFs = ReturnType<typeof memoryServiceFs>;

/** A unit this SDK generated but whose content drifted (classifies `repairable`). */
export const DRIFTED_MARKED_UNIT = `# ${SERVICE_UNIT_MARKER}\nedited by hand\n`;
/** A unit without the marker (classifies `foreign`), e.g. one 0.31 installed. */
export const UNMARKED_UNIT = '<plist>written by someone else</plist>\n';

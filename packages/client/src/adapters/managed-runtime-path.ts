import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export type ManagedRuntimeId = 'claude' | 'codex' | 'dsh' | 'opencode';

// Generations remain addressable while a prepared execution or a running process owns one.
export function managedRuntimeDirectory(installRoot: string, id: ManagedRuntimeId): string {
  if (!path.isAbsolute(installRoot)) throw new TypeError('runtime install root must be absolute');
  return path.join(installRoot, 'runtimes', id);
}

export interface ManagedRuntimePointer {
  readonly generation: string;
  readonly executable: string;
  readonly version: string;
}

export class ManagedRuntimeUnavailableError extends Error {
  constructor() { super('managed runtime installation is unusable'); }
}

export function resolveManagedRuntime(installRoot: string | undefined, id: ManagedRuntimeId): { command: string; source: 'managed'; version: string } | undefined {
  if (installRoot === undefined) return undefined;
  const directory = managedRuntimeDirectory(installRoot, id);
  const current = path.join(directory, 'current.json');
  try {
    if (!lstatSync(current).isFile()) throw new ManagedRuntimeUnavailableError();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ManagedRuntimeUnavailableError();
  }
  try {
    const pointer = JSON.parse(readFileSync(current, 'utf8')) as Partial<ManagedRuntimePointer>;
    if (typeof pointer.generation !== 'string' || !/^generation-[a-f0-9-]{36}$/u.test(pointer.generation)
      || typeof pointer.version !== 'string' || typeof pointer.executable !== 'string' || path.isAbsolute(pointer.executable)) {
      throw new ManagedRuntimeUnavailableError();
    }
    const root = path.join(directory, pointer.generation);
    const command = path.resolve(root, pointer.executable);
    const within = (base: string, file: string) => {
      const relative = path.relative(base, file);
      return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
    };
    if (!within(root, command) || !within(realpathSync(directory), realpathSync(root)) || !within(realpathSync(root), realpathSync(command))
      || !statSync(command).isFile()) throw new ManagedRuntimeUnavailableError();
    accessSync(command, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return { command, source: 'managed', version: pointer.version };
  } catch {
    // Once the pointer exists, any failure is evidence about the managed copy.
    throw new ManagedRuntimeUnavailableError();
  }
}

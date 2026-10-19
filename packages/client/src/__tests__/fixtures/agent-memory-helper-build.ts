import { existsSync } from 'node:fs';
import { resolveAgentMemoryFilesystemHelper } from '../../daemon/agent-memory-helper-release';

const directory = new URL('../../../dist/native/agent-memory-fs/', import.meta.url);

/** An ordinary JS build has no native assets. Partial or invalid builds fail. */
export function hasAgentMemoryHelperBuild(): boolean {
  return ['manifest.json', 'darwin-arm64', 'darwin-x64'].some(name => existsSync(new URL(name, directory)));
}

export function builtAgentMemoryFilesystemHelperBin(): string | undefined {
  if (process.platform !== 'darwin' || !hasAgentMemoryHelperBuild()) return undefined;
  return resolveAgentMemoryFilesystemHelper();
}

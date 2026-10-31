import { existsSync } from 'node:fs';
import { isAgentMemoryFilesystemHelperSupported } from '../../daemon/agent-memory-fs-helper';
import { resolveAgentMemoryFilesystemHelper } from '../../util/agent-memory-helper-release';

const directory = new URL('../../../dist/native/agent-memory-fs/', import.meta.url);

/** An ordinary JS build has no native assets. Partial or invalid builds fail. */
export function hasAgentMemoryHelperBuild(): boolean {
  return ['manifest.json', 'darwin-arm64', 'darwin-x64', 'win32-x64.exe'].some(name => existsSync(new URL(name, directory)));
}

/** The built release helper on a helper platform (macOS, Windows x64). */
export function builtAgentMemoryFilesystemHelperBin(): string | undefined {
  if (!isAgentMemoryFilesystemHelperSupported() || !hasAgentMemoryHelperBuild()) return undefined;
  return resolveAgentMemoryFilesystemHelper();
}

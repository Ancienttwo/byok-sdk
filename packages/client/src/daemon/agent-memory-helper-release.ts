import { copyFileSync, constants, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { AGENT_MEMORY_HELPER_RELEASE } from './agent-memory-helper-release-pin';
import { agentMemoryHelperDigest } from './agent-memory-helper-digest';

function installedReleaseDirectory(): string {
  const root = path.dirname(createRequire(import.meta.url).resolve('@byok-sdk/client/package.json'));
  return path.join(root, 'dist/native/agent-memory-fs');
}

function assetDirectory(assetRoot?: string): string {
  if (assetRoot === undefined) return installedReleaseDirectory();
  if (typeof assetRoot !== 'string' || !path.isAbsolute(assetRoot) || assetRoot.includes('\0')) {
    throw new Error('Agent memory helper asset root must be an absolute directory');
  }
  return assetRoot;
}

function verifiedRelease(directory: string, arch: 'arm64' | 'x64'): string {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const key = `darwin-${arch}` as const;
  const { entries, ...metadata } = AGENT_MEMORY_HELPER_RELEASE;
  if (manifest === null || Object.entries(metadata).some(([field, value]) =>
    JSON.stringify(manifest[field]) !== JSON.stringify(value))) {
    throw new Error('SDK Agent memory helper release manifest mismatch');
  }
  for (const target of ['darwin-arm64', 'darwin-x64'] as const) {
    const entry = manifest.entries?.[target];
    if (entry?.file !== entries[target].file || entry.digest !== entries[target].digest) {
      throw new Error('SDK Agent memory helper release target mismatch');
    }
  }
  const bin = path.join(directory, key);
  if (agentMemoryHelperDigest(readFileSync(bin), arch) !== entries[key].digest) {
    throw new Error('SDK Agent memory helper deployment digest mismatch');
  }
  return realpathSync(bin);
}

/** Resolve SDK release assets only: package-installed by default, or a complete SDK-copied product directory. No PATH or caller digest. */
export function resolveAgentMemoryFilesystemHelper(assetRoot?: string): string {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('SDK Agent memory helper is not admitted on this platform');
  }
  try {
    return verifiedRelease(assetDirectory(assetRoot), process.arch as 'arm64' | 'x64');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(assetRoot === undefined
        ? 'SDK Agent memory helper release assets missing; build with `bun run build:release`'
        : 'SDK Agent memory helper assets missing from explicit root; deploy copyAgentMemoryHelperAssets output from the same SDK release', { cause });
    }
    throw cause;
  }
}

export function verifyAgentMemoryFilesystemHelper(helperBin: string, assetRoot?: string): string {
  const expected = resolveAgentMemoryFilesystemHelper(assetRoot);
  if (realpathSync(helperBin) !== expected) throw new Error('Agent memory helper must use the SDK release artifact');
  return expected;
}

/** Build-time copy of the SDK release manifest and both Darwin targets into a new or empty product asset directory. */
export interface CopyAgentMemoryHelperAssetsOptions {
  readonly outDir: string;
}

/**
 * Run against an installed SDK release, then ship these files with the product.
 * The manifest and Mach-O digest detect deployment errors, not signer trust.
 * Product re-signing remains supported. Returns sorted paths relative to outDir.
 */
export async function copyAgentMemoryHelperAssets(options: CopyAgentMemoryHelperAssetsOptions): Promise<readonly string[]> {
  const directory = installedReleaseDirectory();
  const files = ['darwin-arm64', 'darwin-x64', 'manifest.json'];
  // Validate the whole source before creating or writing the destination.
  for (const file of files) if (!lstatSync(path.join(directory, file)).isFile()) {
    throw new Error('SDK Agent memory helper release assets must be regular files');
  }
  verifiedRelease(directory, 'arm64');
  verifiedRelease(directory, 'x64');
  const outDir = path.resolve(options.outDir);
  let createdDirectory = false;
  try {
    if (!lstatSync(outDir).isDirectory() || readdirSync(outDir).length !== 0) throw new Error('copyAgentMemoryHelperAssets: destination must be a new or empty directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(outDir, { recursive: true });
    createdDirectory = true;
  }
  const copied: string[] = [];
  try {
    for (const file of files) {
      const target = path.join(outDir, file);
      copyFileSync(path.join(directory, file), target, constants.COPYFILE_EXCL);
      copied.push(target);
    }
    // Recheck copied bytes, including after a source mutation during the copy.
    verifiedRelease(outDir, 'arm64');
    verifiedRelease(outDir, 'x64');
    return files;
  } catch (error) {
    // Remove only files this call created, preserving a pre-existing directory.
    for (const file of copied) unlinkSync(file);
    if (createdDirectory) rmdirSync(outDir);
    throw error;
  }
}

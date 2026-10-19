import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { agentMemoryHelperDigest } from './agent-memory-helper-digest';

/** Resolve only SDK-owned release assets. Never search PATH or accept a host digest. */
export function resolveAgentMemoryFilesystemHelper(): string {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('SDK Agent memory helper is not admitted on this platform');
  }
  try {
    const root = path.dirname(createRequire(import.meta.url).resolve('@byok-sdk/client/package.json'));
    const directory = path.join(root, 'dist/native/agent-memory-fs');
    const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    const key = `darwin-${process.arch}`;
    if (manifest.version !== 1 || manifest.helperVersion !== '2' || manifest.protocol !== 2
      || manifest.go !== 'go1.26.5' || manifest.digestAlgorithm !== 'mach-o-content-v1'
      || manifest.signingPolicy !== 'product-resigning-allowed'
      || JSON.stringify(manifest.flags) !== JSON.stringify(['-buildvcs=false', '-trimpath'])
      || !/^[a-f0-9]{64}$/u.test(manifest.sourceDigest ?? '')) {
      throw new Error('SDK Agent memory helper release manifest mismatch');
    }
    const entry = manifest.entries?.[key];
    if (entry?.file !== key || !/^[a-f0-9]{64}$/u.test(entry.digest ?? '')) {
      throw new Error('SDK Agent memory helper release target mismatch');
    }
    const bin = path.join(directory, key);
    if (agentMemoryHelperDigest(readFileSync(bin), process.arch) !== entry.digest) {
      throw new Error('SDK Agent memory helper deployment digest mismatch');
    }
    return realpathSync(bin);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('SDK Agent memory helper release assets missing; build with `bun run build:release`', { cause });
    }
    throw cause;
  }
}

export function verifyAgentMemoryFilesystemHelper(helperBin: string): string {
  const expected = resolveAgentMemoryFilesystemHelper();
  if (realpathSync(helperBin) !== expected) throw new Error('Agent memory helper must use the SDK release artifact');
  return expected;
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Release targets. The digest algorithm of each entry is recorded in the manifest and the pin. */
export const agentMemoryHelperTargets = [
  { name: 'darwin-arm64', goos: 'darwin', goarch: 'arm64', file: 'darwin-arm64', digestAlgorithm: 'mach-o-content-v1' },
  { name: 'darwin-x64', goos: 'darwin', goarch: 'amd64', file: 'darwin-x64', digestAlgorithm: 'mach-o-content-v1' },
  { name: 'win32-x64', goos: 'windows', goarch: 'amd64', file: 'win32-x64.exe', digestAlgorithm: 'pe-content-v1' },
];

/** Hash the native build inputs. Test files are not release binary inputs. */
export function agentMemoryHelperSourceDigest(source) {
  const hash = createHash('sha256');
  const names = readdirSync(source).filter(name =>
    (name.endsWith('.go') && !name.endsWith('_test.go')) || name === 'go.mod').sort();
  for (const name of names) hash.update(name).update('\0').update(readFileSync(path.join(source, name))).update('\0');
  return hash.digest('hex');
}

export function verifyAgentMemoryHelperSourceDigest(source, manifest) {
  assert.equal(manifest.sourceDigest, agentMemoryHelperSourceDigest(source), 'Agent memory helper source digest mismatch');
}

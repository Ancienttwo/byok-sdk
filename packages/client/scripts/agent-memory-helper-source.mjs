import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

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

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHomeManager } from '../dist/index.js';
import { openAgentMemoryFilesystemHelper } from '../dist/agent-memory/index.js';

assert.equal(process.platform, 'darwin');
const goarch = process.arch === 'arm64' ? 'arm64' : 'amd64';
if (process.env.BYOK_EXPECT_GOARCH) assert.equal(goarch, process.env.BYOK_EXPECT_GOARCH);
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'byok-helper-runtime-')));
const binding = await new AgentHomeManager({ hostStorageRoot: root }).prepare({ agentId: 'runtime', profileRevision: 'p1' });
try {
  const helperBin = fileURLToPath(new URL(`../dist/native/agent-memory-fs/darwin-${process.arch}`, import.meta.url));
  const filesystem = await openAgentMemoryFilesystemHelper({ helperBin, canonicalHome: binding.lease.canonicalHome, homeIdentity: binding.lease.homeIdentity });
  try {
    const old = await filesystem.read('MEMORY.md', 1024);
    await filesystem.replace('MEMORY.md', old.revision, 'runtime identity accepted', 1024);
    assert.equal(readFileSync(path.join(binding.lease.canonicalHome, 'MEMORY.md'), 'utf8'), 'runtime identity accepted');
  } finally { await filesystem.close(); }
} finally { await binding.lease.release(); rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', arch: process.arch, goarch, identity: 'accepted', strictBarrier: 'passed' }));

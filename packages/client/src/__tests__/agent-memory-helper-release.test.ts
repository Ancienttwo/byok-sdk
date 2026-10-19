import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentMemoryHelperDigest } from '../daemon/agent-memory-helper-digest';
import { resolveAgentMemoryFilesystemHelper, verifyAgentMemoryFilesystemHelper } from '../daemon/agent-memory-helper-release';
import { helperAgentMemoryIntentBackend } from '../daemon/agent-memory-intent';
import { hasAgentMemoryHelperBuild } from './fixtures/agent-memory-helper-build';
import { AgentHomeManager } from '../agent-home';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const directory = new URL('../../dist/native/agent-memory-fs/', import.meta.url);

describe.skipIf(!hasAgentMemoryHelperBuild())('SDK Agent memory helper release content digest', () => {
  it.each(['arm64', 'x64'])('binds the %s image and rejects code, metadata, architecture and format changes', arch => {
    const bytes = readFileSync(new URL(`darwin-${arch}`, directory));
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
    expect(agentMemoryHelperDigest(bytes, arch)).toBe(manifest.entries[`darwin-${arch}`].digest);
    const changed = Buffer.from(bytes);
    changed[16384] = changed[16384]! ^ 1;
    expect(agentMemoryHelperDigest(changed, arch)).not.toBe(agentMemoryHelperDigest(bytes, arch));
    const header = Buffer.from(bytes);
    header[24] = header[24]! ^ 1;
    expect(agentMemoryHelperDigest(header, arch)).not.toBe(agentMemoryHelperDigest(bytes, arch));
    expect(() => agentMemoryHelperDigest(bytes, arch === 'arm64' ? 'x64' : 'arm64')).toThrow();
    expect(() => agentMemoryHelperDigest(bytes.subarray(0, 100), arch)).toThrow();
    expect(() => agentMemoryHelperDigest(Buffer.concat([bytes, Buffer.alloc(1)]), arch)).toThrow();
    let offset = 32;
    for (let index = 0; index < bytes.readUInt32LE(16); index++) {
      const size = bytes.readUInt32LE(offset + 4);
      if (bytes.readUInt32LE(offset) === 0x19 && bytes.subarray(offset + 8, offset + 24).toString('ascii').startsWith('__LINKEDIT')) {
        for (const vmSize of [0n, bytes.readBigUInt64LE(offset + 48) - 1n, 1n << 63n]) {
          const invalid = Buffer.from(bytes);
          invalid.writeBigUInt64LE(vmSize, offset + 32);
          expect(() => agentMemoryHelperDigest(invalid, arch)).toThrow();
        }
      }
      offset += size;
    }
    const command = Buffer.from(bytes);
    command.writeUInt32LE(0xffffffff, 36);
    expect(() => agentMemoryHelperDigest(command, arch)).toThrow();
  });

  (process.platform === 'darwin' ? it : it.skip).each(['arm64', 'x64'])('allows real product re-signing for %s and still binds code', async arch => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-helper-resign-'));
    roots.push(root);
    const source = readFileSync(new URL(`darwin-${arch}`, directory));
    const target = path.join(root, 'helper');
    await fs.writeFile(target, source, { mode: 0o700 });
    execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'test.byok.product.helper', '--options', 'runtime', target]);
    execFileSync('codesign', ['--verify', '--strict', target]);
    const signed = await fs.readFile(target);
    expect(createHash('sha256').update(signed).digest('hex')).not.toBe(createHash('sha256').update(source).digest('hex'));
    expect(agentMemoryHelperDigest(signed, arch)).toBe(agentMemoryHelperDigest(source, arch));
    signed[16384] = signed[16384]! ^ 1;
    expect(agentMemoryHelperDigest(signed, arch)).not.toBe(agentMemoryHelperDigest(source, arch));
  });

  (process.platform === 'darwin' ? it : it.skip)('grants both proofs only to the SDK artifact and opens a new durable home', async () => {
    const bin = resolveAgentMemoryFilesystemHelper();
    expect(verifyAgentMemoryFilesystemHelper(bin)).toBe(bin);
    expect(() => verifyAgentMemoryFilesystemHelper('/bin/sh')).toThrow('SDK release artifact');
    const backend = helperAgentMemoryIntentBackend(bin);
    expect(backend.conflictProvesNoRename).toBe(true);
    expect(backend.strictLedgerBarrier).toBe(true);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-helper-release-home-'));
    roots.push(root);
    const binding = await new AgentHomeManager({ hostStorageRoot: path.join(root, 'new', 'host') }).prepare({ agentId: 'one', profileRevision: 'p1' });
    try {
      const filesystem = await backend.openFilesystem!(binding.lease);
      try {
        const old = await filesystem.read('.byok/agent-memory-intents-v1.json', 1024 * 1024);
        await filesystem.replace('.byok/agent-memory-intents-v1.json', old.revision, 'x'.repeat(1024 * 1024), 1024 * 1024);
        expect((await filesystem.read('.byok/agent-memory-intents-v1.json', 1024 * 1024)).byteCount).toBe(1024 * 1024);
      } finally { await filesystem.close(); }
    } finally { await binding.lease.release(); }
  });
});

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentMemoryHelperDigest, agentMemoryHelperPeDigest, agentMemoryHelperTargetDigest } from '../util/agent-memory-helper-digest';
import { resolveAgentMemoryFilesystemHelper, verifyAgentMemoryFilesystemHelper } from '../util/agent-memory-helper-release';
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

  it('binds the win32-x64 PE image and admits only a certificate table at the end', () => {
    const bytes = readFileSync(new URL('win32-x64.exe', directory));
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
    const digest = agentMemoryHelperPeDigest(bytes);
    expect(manifest.entries['win32-x64']).toEqual({ file: 'win32-x64.exe', digestAlgorithm: 'pe-content-v1', digest });
    expect(agentMemoryHelperTargetDigest('win32-x64', bytes)).toBe(digest);
    const optional = bytes.readUInt32LE(0x3c) + 24;
    const sectionEnd = bytes.length;
    const changed = Buffer.from(bytes);
    changed[4096] = changed[4096]! ^ 1;
    expect(agentMemoryHelperPeDigest(changed)).not.toBe(digest);
    const header = Buffer.from(bytes);
    header[optional + 68] = header[optional + 68]! ^ 1;
    expect(agentMemoryHelperPeDigest(header)).not.toBe(digest);
    // A signer writes CheckSum, the certificate entry and an aligned table at the end.
    const signedLike = (table: Buffer, start = sectionEnd, size = table.length): Buffer => {
      const signed = Buffer.concat([bytes, Buffer.alloc(start - bytes.length), table]);
      signed.writeUInt32LE(0x1234, optional + 64);
      signed.writeUInt32LE(start, optional + 144);
      signed.writeUInt32LE(size, optional + 148);
      return signed;
    };
    const certificate = Buffer.alloc(24); certificate.writeUInt32LE(20, 0);
    expect(agentMemoryHelperPeDigest(signedLike(certificate))).toBe(digest);
    expect(agentMemoryHelperPeDigest(signedLike(certificate, sectionEnd + 8))).not.toBe(digest);
    // A content length that is not a multiple of 8: the signer pads it with zeros before the table.
    const odd = Buffer.concat([bytes, Buffer.alloc(3)]);
    const oddSigned = Buffer.concat([odd, Buffer.alloc(5), certificate]);
    oddSigned.writeUInt32LE(0x1234, optional + 64);
    oddSigned.writeUInt32LE(odd.length + 5, optional + 144);
    oddSigned.writeUInt32LE(certificate.length, optional + 148);
    expect(agentMemoryHelperPeDigest(oddSigned)).toBe(agentMemoryHelperPeDigest(odd));
    expect(agentMemoryHelperPeDigest(odd)).not.toBe(digest);
    for (const invalid of [
      signedLike(certificate, sectionEnd + 4),
      signedLike(certificate, sectionEnd, certificate.length - 8),
      signedLike(Buffer.alloc(8)),
      (() => { const forged = Buffer.from(bytes); forged.writeUInt32LE(4096, optional + 144); forged.writeUInt32LE(bytes.length - 4096, optional + 148); return forged; })(),
      Buffer.concat([bytes.subarray(0, 0x3c + 4)]),
    ]) expect(() => agentMemoryHelperPeDigest(invalid)).toThrow('Invalid Agent memory helper PE image');
    const machine = Buffer.from(bytes); machine.writeUInt16LE(0xaa64, optional - 20);
    expect(() => agentMemoryHelperPeDigest(machine)).toThrow('Invalid Agent memory helper PE image');
    expect(() => agentMemoryHelperPeDigest(readFileSync(new URL('darwin-x64', directory)))).toThrow('Invalid Agent memory helper PE image');
    expect(() => agentMemoryHelperTargetDigest('win32-x64', readFileSync(new URL('darwin-arm64', directory)))).toThrow();
    expect(() => agentMemoryHelperTargetDigest('win32-arm64', bytes)).toThrow('Unknown Agent memory helper target');
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

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentMemoryHelperDigest } from '../src/daemon/agent-memory-helper-digest.ts';

const installRoot = process.argv[2];
if (!installRoot) throw new Error('Expected an isolated installed package root');
const require = createRequire(path.join(installRoot, 'package.json'));
const root = path.dirname(require.resolve('@byok-sdk/client/package.json'));
const directory = path.join(root, 'dist/native/agent-memory-fs');
const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
assert.equal(manifest.digestAlgorithm, 'mach-o-content-v1');
assert.equal(manifest.signingPolicy, 'product-resigning-allowed');
assert.deepEqual(manifest.flags, ['-buildvcs=false', '-trimpath']);
for (const arch of ['arm64', 'x64']) {
  const bin = path.join(directory, `darwin-${arch}`);
  assert.equal(agentMemoryHelperDigest(readFileSync(bin), arch), manifest.entries[`darwin-${arch}`].digest);
}
if (process.platform === 'darwin') {
  const sdk = await import(pathToFileURL(require.resolve('@byok-sdk/client')));
  const memory = await import(pathToFileURL(require.resolve('@byok-sdk/client/agent-memory')));
  const bin = path.join(directory, `darwin-${process.arch}`);
  const original = readFileSync(bin);
  const manifestFile = path.join(directory, 'manifest.json');
  const originalManifest = readFileSync(manifestFile);
  const scratch = mkdtempSync(path.join(tmpdir(), 'byok-packed-helper-'));
  const binding = await new sdk.AgentHomeManager({ hostStorageRoot: scratch }).prepare({ agentId: 'packed-helper', profileRevision: 'p1' });
  const open = () => memory.openAgentMemoryFilesystemHelper({ helperBin: bin, canonicalHome: binding.lease.canonicalHome, homeIdentity: binding.lease.homeIdentity });
  try {
    let filesystem = await open();
    await filesystem.close();
    execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'test.byok.packed.product', bin]);
    execFileSync('codesign', ['--verify', '--strict', bin]);
    filesystem = await open();
    await filesystem.close();
    const changed = readFileSync(bin);
    changed[16384] ^= 1;
    writeFileSync(bin, changed);
    await assert.rejects(open(), /deployment digest mismatch/);
    const daemonConfig = { strictAgentOnly: true, productName: 'Packed helper', productId: 'packed-helper', serverUrl: 'http://localhost:1', storeDir: path.join(scratch, 'store'), agentHome: { hostStorageRoot: scratch }, localAgentRelease: { version: '0.0.0-test' }, agentMemoryIntents: { fetch: async () => { throw new Error('must not fetch'); }, complete: async () => { throw new Error('must not complete'); } } };
    assert.throws(() => sdk.createDaemonWithAdapters(daemonConfig, []), /deployment digest mismatch/);
    writeFileSync(bin, original);
    for (const patch of [{ protocol: 1 }, { helperVersion: 'wrong' }, { entries: {} }]) {
      writeFileSync(manifestFile, JSON.stringify({ ...manifest, ...patch }));
      assert.throws(() => sdk.createDaemonWithAdapters(daemonConfig, []), /manifest mismatch|target mismatch/);
    }
    writeFileSync(manifestFile, originalManifest);
    const wrongArch = process.arch === 'arm64' ? 'x64' : 'arm64';
    writeFileSync(bin, readFileSync(path.join(directory, `darwin-${wrongArch}`)));
    await assert.rejects(open(), /Invalid Agent memory helper Mach-O image/);

    console.log('[release-pack] re-signed SDK helper accepted; changed code rejected before daemon capability');
  } finally {
    writeFileSync(bin, original);
    writeFileSync(manifestFile, originalManifest);
    chmodSync(bin, 0o755);
    await binding.lease.release();
    rmSync(scratch, { recursive: true, force: true });
  }
}
console.log('[release-pack] both SDK Mach-O helper artifacts match the release manifest');

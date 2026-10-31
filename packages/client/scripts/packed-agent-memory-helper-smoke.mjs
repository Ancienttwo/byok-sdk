import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentMemoryHelperDigest, agentMemoryHelperTargetDigest } from '../src/util/agent-memory-helper-digest.ts';

const installRoot = process.argv[2];
if (!installRoot) throw new Error('Expected an isolated installed package root');
const require = createRequire(path.join(installRoot, 'package.json'));
const root = path.dirname(require.resolve('@byok-sdk/client/package.json'));
const directory = path.join(root, 'dist/native/agent-memory-fs');
const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, 2);
assert.equal(manifest.signingPolicy, 'product-resigning-allowed');
assert.deepEqual(manifest.flags, ['-buildvcs=false', '-trimpath']);
assert.deepEqual(Object.fromEntries(Object.entries(manifest.entries).map(([target, entry]) => [target, [entry.file, entry.digestAlgorithm]])), {
  'darwin-arm64': ['darwin-arm64', 'mach-o-content-v1'],
  'darwin-x64': ['darwin-x64', 'mach-o-content-v1'],
  'win32-x64': ['win32-x64.exe', 'pe-content-v1'],
});
for (const [target, entry] of Object.entries(manifest.entries)) {
  assert.equal(agentMemoryHelperTargetDigest(target, readFileSync(path.join(directory, entry.file))), entry.digest);
}
if (process.platform === 'win32') {
  const bin = path.join(directory, 'win32-x64.exe');
  const original = readFileSync(bin);
  const scratch = mkdtempSync(path.join(tmpdir(), 'byok-packed-helper-pe-'));
  const copy = path.join(scratch, 'agent-memory-fs.exe');
  // A real signer, not a model of one: Authenticode signing twice must keep
  // the content digest, and changed code must not. Windows PowerShell gets no
  // inherited PSModulePath: a pwsh 7 parent's module path hides its Cert: drive.
  const signerEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
  const sign = () => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=byok packed helper test' -CertStoreLocation Cert:\\CurrentUser\\My; "
    + "try { $result = Set-AuthenticodeSignature -FilePath $env:BYOK_SIGN_TARGET -Certificate $cert -HashAlgorithm SHA256; if ($null -eq $result.SignerCertificate) { throw 'no signature written' } } "
    + "finally { Remove-Item -LiteralPath (Join-Path 'Cert:\\CurrentUser\\My' $cert.Thumbprint) }"], { env: { ...signerEnv, BYOK_SIGN_TARGET: copy }, stdio: 'inherit' });
  try {
    writeFileSync(copy, original);
    assert.equal(execFileSync(copy, ['--version'], { encoding: 'utf8' }), `${manifest.helperVersion}\n`);
    const expected = manifest.entries['win32-x64'].digest;
    sign();
    const signed = readFileSync(copy);
    assert.notDeepEqual(signed, original);
    assert.equal(agentMemoryHelperTargetDigest('win32-x64', signed), expected);
    sign();
    assert.equal(agentMemoryHelperTargetDigest('win32-x64', readFileSync(copy)), expected);
    assert.equal(execFileSync(copy, ['--version'], { encoding: 'utf8' }), `${manifest.helperVersion}\n`);
    const changed = Buffer.from(signed);
    changed[4096] ^= 1;
    assert.notEqual(agentMemoryHelperTargetDigest('win32-x64', changed), expected);
    assert.throws(() => agentMemoryHelperTargetDigest('win32-x64', readFileSync(path.join(directory, 'darwin-x64'))), /Invalid Agent memory helper PE image/);
    console.log('[release-pack] Authenticode-signed SDK helper keeps its digest; changed code rejected');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.platform === 'darwin') {
  const clientManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const sdk = await import(pathToFileURL(path.resolve(root, clientManifest.exports['.'].import)));
  const memory = await import(pathToFileURL(path.resolve(root, clientManifest.exports['./agent-memory'].import)));
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
    const daemonConfig = { productName: 'Packed helper', productId: 'packed-helper', serverUrl: 'http://localhost:1', storeDir: path.join(scratch, 'store'), agentHome: { hostStorageRoot: scratch }, localAgentRelease: { version: '0.0.0-test' }, agentMemoryIntents: { fetch: async () => { throw new Error('must not fetch'); }, complete: async () => { throw new Error('must not complete'); } } };
    assert.throws(() => sdk.createDaemonWithAdapters(daemonConfig, []), /deployment digest mismatch/);
    const forgedManifest = structuredClone(manifest);
    forgedManifest.entries[`darwin-${process.arch}`].digest = agentMemoryHelperDigest(changed, process.arch);
    writeFileSync(manifestFile, JSON.stringify(forgedManifest));
    await assert.rejects(open(), /target mismatch/);
    writeFileSync(manifestFile, originalManifest);
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
console.log('[release-pack] every SDK helper artifact matches the release manifest');

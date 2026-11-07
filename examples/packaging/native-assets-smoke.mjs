import { mkdtemp, cp, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { copySdkNativeAssets } from '@byok-sdk/client';

const root = await mkdtemp(path.join(tmpdir(), 'sdk-native-sea-'));
const assets = path.join(root, 'assets');
let host;
let hostExited;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async check => { const deadline = Date.now() + 15_000; while (!check()) { if (Date.now() > deadline) throw Error('native SEA fixture condition timed out'); await new Promise(r => setTimeout(r, 50)); } };
try {
  const files = await copySdkNativeAssets({ outDir: assets, platform: 'win32', arch: 'x64' });
  assert.deepEqual(files, ['KOFFI-LICENSE.txt', 'agent-memory-fs/manifest.json', 'agent-memory-fs/win32-x64.exe', 'manifest.json', 'win32-x64/koffi.node']);
  console.log('Pinned win32-x64 assets copied on', process.platform, process.arch);
  if (process.argv.includes('--copy-only')) process.exitCode = 0;
  else {
    assert.equal(process.platform, 'win32', 'actual Job Object SEA qualification requires Windows');
    assert.equal(process.arch, 'x64');
    const build = 'examples/packaging/.native-sea-build';
    execFileSync('bash', ['templates/packaging/sea/build.sh', 'examples/packaging/native-assets-fixture.ts', build], { stdio: 'inherit' });
    const executable = path.join(root, 'host.exe');
    await cp(path.join(build, 'launcher-sea.exe'), executable);
    const credentials = assetRoot => JSON.parse(execFileSync(executable, ['--credentials', assetRoot, root], { cwd: root, encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } }));
    assert.deepEqual(credentials(assets), { status: 'unpaired', roundTrip: true, cleared: true });
    let output = '', errors = '';
    host = spawn(executable, ['--host', assets], { cwd: root, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: root, TMP: root } });
    hostExited = new Promise((resolve, reject) => { host.once('exit', resolve); host.once('error', reject); });
    host.stdout.on('data', chunk => { output += chunk; });
    host.stderr.on('data', chunk => { errors += chunk; });
    await until(() => output.includes('\n') || host.exitCode !== null);
    assert.equal(host.exitCode, null, errors);
    const receipt = JSON.parse(output.trim().split('\n')[0]);
    assert.ok(Number.isInteger(receipt.runtime) && Number.isInteger(receipt.descendant), output);
    assert.ok(alive(receipt.runtime) && alive(receipt.descendant));
    // Terminate only the host, not a tree sweep. Kernel job close must kill both children.
    host.kill('SIGKILL');
    await until(() => !alive(receipt.runtime) && !alive(receipt.descendant));
    await rename(assets, `${assets}-missing`);
    // Keep cwd valid; absent files inside the configured root must fail closed.
    await import('node:fs/promises').then(fs => fs.mkdir(assets));
    let rejected = '';
    try { execFileSync(executable, ['--host', assets], { cwd: root, encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } }); }
    catch (error) { rejected = String(error.stdout); }
    const failure = JSON.parse(rejected.trim());
    assert.equal(failure.alive, false);
    assert.match(failure.failed, /native assets/);
    assert.deepEqual(credentials(assets), { failed: 'DeviceCredentialStoreUnavailableError' });
    await rm(assets, { recursive: true });
    await cp(`${assets}-missing`, assets, { recursive: true });
    const manifest = path.join(assets, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ ...JSON.parse(await readFile(manifest, 'utf8')), sha256: '0'.repeat(64) }));
    assert.deepEqual(credentials(assets), { failed: 'DeviceCredentialStoreUnavailableError' });
    console.log('Windows x64 relocated SEA ownership, credential round trip and missing or modified assets refusal passed');
  }
} finally {
  host?.kill('SIGKILL');
  await hostExited;
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

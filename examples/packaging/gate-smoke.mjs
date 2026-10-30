import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// The path-mutation gate as ESM, CJS and a relocated SEA binary (#1149).
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const work = mkdtempSync(join(tmpdir(), 'byok-gate-pack-'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.signal ?? result.status}`);
  return result.stdout;
}
function probe(command, args, cwd) {
  assert.match(run(command, args, { cwd }), new RegExp(`^BYOK_GATE_BUNDLE_OK ${process.platform}$`, 'm'));
}
try {
  const entry = join(here, 'gate-fixture.ts'), esm = join(work, 'fixture.mjs'), cjs = join(work, 'fixture.cjs');
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: esm });
  probe(process.execPath, [esm], work);
  await build({ entryPoints: [esm], bundle: true, platform: 'node', format: 'cjs',
    define: { 'import.meta.url': 'undefined' }, outfile: cjs });
  probe(process.execPath, [cjs], work);
  if (process.argv.includes('--sea')) {
    const output = join(work, 'sea');
    run('bash', [join(root, 'templates/packaging/sea/build.sh'), entry, output], { cwd: root });
    const binary = process.platform === 'win32' ? 'launcher-sea.exe' : 'launcher-sea';
    const isolated = join(work, 'isolated'); mkdirSync(isolated);
    const shipped = join(isolated, binary); copyFileSync(join(output, binary), shipped);
    probe(shipped, [], isolated);
  }
} finally { rmSync(work, { recursive: true, force: true }); }

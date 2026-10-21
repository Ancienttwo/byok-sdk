import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const work = mkdtempSync(join(tmpdir(), 'byok-sqlite-pack-'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.signal ?? result.status}`);
  return result.stdout;
}
function probe(command, args, cwd) {
  assert.match(run(command, args, { cwd }), /^BYOK_SQLITE_BUNDLE_OK server daemon-journal keys$/m);
}
try {
  const entry = join(here, 'sqlite-fixture.ts'), esm = join(work, 'fixture.mjs'), cjs = join(work, 'fixture.cjs');
  // Match the established SEA recipe's tree-shaking pass before imposing CJS's no-TLA syntax.
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

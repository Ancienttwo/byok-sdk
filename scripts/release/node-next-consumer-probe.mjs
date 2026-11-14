// NodeNext consumer probe (#1828): a `"type": "module"` consumer with
// module/moduleResolution NodeNext imports every types-bearing exports entry
// of the installed tarballs. The library declarations must compile, and one
// deliberate wrong-type assignment per consumer must fail with TS2322; that
// failure proves the imports carry real types, not `any` from an unresolved
// specifier.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimeSmokeImports } from '../api-surface/entry-closure.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The Node runtime smoke exports that carry declarations. */
export async function typesBearingEntries(root = repoRoot) {
  const entries = JSON.parse(readFileSync(path.join(root, 'api-surface', 'entries.json'), 'utf8'));
  const typed = new Set(Object.entries(entries)
    .filter(([, entry]) => entry.facts?.types?.length > 0)
    .map(([id]) => id.replace(/\[.*\]$/, '')));
  return (await runtimeSmokeImports(root)).node.filter(specifier => typed.has(specifier));
}

function probeSource(specifiers, wrong) {
  assert.ok(specifiers.includes(wrong.from), `${wrong.from} must be one of the probed entries`);
  const lines = specifiers.map((specifier, index) => `import type * as m${index} from '${specifier}';`);
  lines.push(`import { ${wrong.name} } from '${wrong.from}';`);
  lines.push(`export type Entries = [${specifiers.map((_, index) => `typeof m${index}`).join(', ')}];`);
  lines.push(`export const wrong: number = ${wrong.name};`);
  return { source: `${lines.join('\n')}\n`, wrongLine: lines.length };
}

function tscEntry() {
  const require = createRequire(path.join(repoRoot, 'package.json'));
  const manifestPath = require.resolve('typescript/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return path.join(path.dirname(manifestPath), manifest.bin.tsc);
}

function compilerOptions() {
  // The cloud-dataplane declarations import 'pg' and the package ships no
  // `@types/pg` dependency, so the consumer supplies it, as a Host must.
  const dataplane = createRequire(path.join(repoRoot, 'packages/cloud-dataplane/package.json'));
  const pgTypes = path.dirname(dataplane.resolve('@types/pg/package.json'));
  return {
    target: 'ES2022',
    lib: ['ES2024'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    types: ['node'],
    typeRoots: [path.join(repoRoot, 'node_modules', '@types')],
    paths: { pg: [path.join(pgTypes, 'index.d.mts')] },
  };
}

export async function nodeNextConsumerProbe(installRoot, entries) {
  entries ??= await typesBearingEntries();
  const consumer = path.join(installRoot, 'node-next-consumer-node');
  mkdirSync(consumer);
  const { source, wrongLine } = probeSource(entries, { from: '@byok-sdk/client', name: 'createDaemonWithAdapters' });
  writeFileSync(path.join(consumer, 'package.json'), `${JSON.stringify({ name: 'node-next-consumer-node', private: true, type: 'module' })}\n`);
  writeFileSync(path.join(consumer, 'probe.ts'), source);
  writeFileSync(path.join(consumer, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: compilerOptions(),
    include: ['probe.ts'],
  }, null, 2)}\n`);
  const result = spawnSync(process.execPath, [tscEntry(), '--project', 'tsconfig.json', '--pretty', 'false'], {
    cwd: consumer, encoding: 'utf8', timeout: 300_000,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`;
  const errors = output.split('\n').filter(line => /error TS\d+/.test(line));
  assert.deepEqual(errors.map(line => line.match(/^(.*?)\((\d+),\d+\): error (TS\d+)/)?.slice(1)), [['probe.ts', String(wrongLine), 'TS2322']],
    `[node-next-consumer] node: expected exactly the deliberate TS2322 at probe.ts:${wrongLine}\n${output}`);
  console.log(`[node-next-consumer] node: ${entries.length} entries compile under NodeNext (skipLibCheck false); the deliberate wrong assignment fails with TS2322`);
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error('provide the installed tarball consumer root');
  await nodeNextConsumerProbe(path.resolve(process.argv[2]));
}

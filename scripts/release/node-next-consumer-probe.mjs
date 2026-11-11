// NodeNext consumer probe (#1828): a `"type": "module"` consumer with
// module/moduleResolution NodeNext imports every types-bearing exports entry
// of the installed tarballs. The library declarations must compile, and one
// deliberate wrong-type assignment per consumer must fail with TS2322; that
// failure proves the imports carry real types, not `any` from an unresolved
// specifier.
//
// cloud-do loads the Workers types, whose globals clash with the Node types in
// library checking under every resolution mode, so its consumer keeps
// `skipLibCheck: true`; its wrong-type assignment still proves real types.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const LANES = {
  node: {
    skipLibCheck: false,
    wrong: { from: '@byok-sdk/client', name: 'createDaemonWithAdapters' },
  },
  worker: {
    skipLibCheck: true,
    wrong: { from: '@byok-sdk/cloud-do', name: 'AgentDO' },
  },
};

/** Every exports entry with declarations, split by whether its runtime needs `cloudflare:`. */
export function typesBearingEntries(root = repoRoot) {
  const entries = JSON.parse(readFileSync(path.join(root, 'api-surface', 'entries.json'), 'utf8'));
  const lanes = { node: [], worker: [] };
  for (const [specifier, entry] of Object.entries(entries)) {
    if (entry.kind !== 'exports' || !entry.facts?.types?.length) continue;
    const worker = (entry.facts.bareImports ?? []).some(bare => bare.startsWith('cloudflare:'));
    lanes[worker ? 'worker' : 'node'].push(specifier);
  }
  return { node: lanes.node.sort(), worker: lanes.worker.sort() };
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

function compilerOptions(lane) {
  const options = {
    target: 'ES2022',
    lib: ['ES2024'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    skipLibCheck: LANES[lane].skipLibCheck,
    noEmit: true,
  };
  if (lane === 'node') {
    // The cloud-dataplane declarations import 'pg' and the package ships no
    // `@types/pg` dependency, so the consumer supplies it, as a Host must.
    const dataplane = createRequire(path.join(repoRoot, 'packages/cloud-dataplane/package.json'));
    const pgTypes = path.dirname(dataplane.resolve('@types/pg/package.json'));
    return { ...options, types: ['node'], typeRoots: [path.join(repoRoot, 'node_modules', '@types')], paths: { pg: [path.join(pgTypes, 'index.d.mts')] } };
  }
  return { ...options, types: [] };
}

function workerTypeFiles() {
  const require = createRequire(path.join(repoRoot, 'packages/cloud-do/package.json'));
  return [path.join(path.dirname(require.resolve('@cloudflare/workers-types/package.json')), 'index.d.ts')];
}

export function nodeNextConsumerProbe(installRoot, entries = typesBearingEntries()) {
  for (const lane of ['node', 'worker']) {
    const consumer = path.join(installRoot, `node-next-consumer-${lane}`);
    mkdirSync(consumer);
    const { source, wrongLine } = probeSource(entries[lane], LANES[lane].wrong);
    writeFileSync(path.join(consumer, 'package.json'), `${JSON.stringify({ name: `node-next-consumer-${lane}`, private: true, type: 'module' })}\n`);
    writeFileSync(path.join(consumer, 'probe.ts'), source);
    writeFileSync(path.join(consumer, 'tsconfig.json'), `${JSON.stringify({
      compilerOptions: compilerOptions(lane),
      ...(lane === 'worker' ? { files: workerTypeFiles() } : {}),
      include: ['probe.ts'],
    }, null, 2)}\n`);
    const result = spawnSync(process.execPath, [tscEntry(), '--project', 'tsconfig.json', '--pretty', 'false'], {
      cwd: consumer, encoding: 'utf8', timeout: 300_000,
    });
    if (result.error) throw result.error;
    const output = `${result.stdout}${result.stderr}`;
    const errors = output.split('\n').filter(line => /error TS\d+/.test(line));
    assert.deepEqual(errors.map(line => line.match(/^(.*?)\((\d+),\d+\): error (TS\d+)/)?.slice(1)), [['probe.ts', String(wrongLine), 'TS2322']],
      `[node-next-consumer] ${lane}: expected exactly the deliberate TS2322 at probe.ts:${wrongLine}\n${output}`);
    console.log(`[node-next-consumer] ${lane}: ${entries[lane].length} entries compile under NodeNext (skipLibCheck ${LANES[lane].skipLibCheck}); the deliberate wrong assignment fails with TS2322`);
  }
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error('provide the installed tarball consumer root');
  nodeNextConsumerProbe(path.resolve(process.argv[2]));
}

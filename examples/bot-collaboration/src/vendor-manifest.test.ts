import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { imports } from './import-scan.test-support';

/**
 * #886: `src/VENDOR.md` lists what a Host copies, in layers. Each layer's list must equal the import graph walked from
 * that layer's roots: its files, and the packages and K4 names those files import. Every other source file is listed
 * as not vendored. So the list can neither miss a file nor keep a stale one. K4 is published in `@byok-sdk/server`
 * (#1106), so it is a package import, not a layer.
 */
const K8 = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(K8, '../../packages/server');
const LAYERS = ['rules', 'host', 'vectors', 'unvendored'] as const;
type Layer = typeof LAYERS[number];
interface Listed { files: string[]; packages: Record<string, string[] | undefined> }
interface Graph { files: string[]; packages: Record<string, string[]> }

/** One fenced block per layer: "```vendor <layer>". A line is a file path, or a package with an optional `: names` (colon and space). */
function manifest(text: string): Map<string, Listed> {
  const layers = new Map<string, Listed>();
  for (const [, layer, body] of text.replace(/\r\n/g, '\n').matchAll(/^```vendor ([a-z0-9-]+)\n([\s\S]*?)^```$/gm)) {
    if (layers.has(layer!)) throw new Error(`Duplicate vendor layer ${layer}`);
    const listed: Listed = { files: [], packages: {} };
    for (const line of body!.split('\n').map(row => row.trim()).filter(Boolean)) {
      if (line.startsWith('src/')) listed.files.push(line);
      else {
        const [spec, names] = line.split(/:\s+/);
        listed.packages[spec!] = names?.split(/\s+/).filter(Boolean).sort();
      }
    }
    layers.set(layer!, listed);
  }
  return layers;
}
const exists = (path: string) => existsSync(path) && statSync(path).isFile();
/** Manifest paths use `/` on every platform. */
const posix = (path: string) => path.split(sep).join('/');
function resolveFile(from: string, specifier: string): string {
  const base = join(dirname(from), specifier);
  const found = [base, `${base}.ts`, join(base, 'index.ts')].find(exists);
  if (!found) throw new Error(`Cannot resolve ${specifier} from ${from}`);
  return found;
}
/** Walks relative imports from the roots, `import type` too: a copy still needs those files to typecheck. */
function graph(root: string, roots: string[], below: ReadonlySet<string>): Graph {
  const seen = new Set<string>(), packages: Record<string, Set<string>> = {}, stack = roots.map(file => join(root, file));
  while (stack.length) {
    const file = normalize(stack.pop()!);
    if (seen.has(file) || below.has(file)) continue;
    seen.add(file);
    for (const row of imports(readFileSync(file, 'utf8'))) {
      if (row.from.startsWith('.')) { stack.push(resolveFile(file, row.from)); continue; }
      const names = packages[row.from] ??= new Set();
      for (const name of row.names ?? []) names.add(name);
    }
  }
  return { files: [...seen].map(file => posix(relative(root, file))).sort(),
    packages: Object.fromEntries(Object.entries(packages).sort().map(([key, names]) => [key, [...names].sort()])) };
}
/** A listed package without names allows any name. A listed package with names must import exactly those. */
function compare(listed: Listed, found: Graph) {
  return {
    files: [...listed.files].sort(),
    packages: Object.fromEntries(Object.entries(listed.packages).sort()
      .map(([key, names]) => [key, names ?? found.packages[key] ?? []])),
  };
}
const sources = (dir: string, prefix = ''): string[] => readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(dir, `${prefix}/${entry.name}`) : /\.[cm]?ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [`${prefix}/${entry.name}`] : []);
const packageJson = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
  exports: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const packageName = (spec: string) => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;

function vendorLayers() {
  const listed = manifest(readFileSync(join(K8, 'src/VENDOR.md'), 'utf8'));
  const k8 = packageJson(K8);
  const roots: Record<'rules' | 'host' | 'vectors', string[]> = {
    rules: readdirSync(join(K8, 'src/rules')).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).map(name => `src/rules/${name}`),
    host: ['src/host.ts', 'src/index.ts'],
    vectors: Object.values(k8.exports).filter(target => target.endsWith('.test-support.ts')).map(target => target.replace(/^\.\//, '')),
  };
  const below = new Set<string>(), found: Partial<Record<Layer, Graph>> = {};
  for (const layer of ['rules', 'host', 'vectors'] as const) {
    found[layer] = graph(K8, roots[layer], below);
    for (const file of found[layer].files) below.add(join(K8, file));
  }
  return { listed, found, k8 };
}

it('lists each layer exactly as its import graph', () => {
  const { listed, found } = vendorLayers();
  expect([...listed.keys()], 'vendor layers in src/VENDOR.md').toEqual([...LAYERS]);
  for (const layer of ['rules', 'host', 'vectors'] as const) {
    expect(compare(listed.get(layer)!, found[layer]!), `${layer}: update src/VENDOR.md`).toEqual(found[layer]);
  }
});

it('lists every other K8 source file as not vendored, and only those', () => {
  const { listed, found } = vendorLayers();
  const vendored = new Set((['rules', 'host', 'vectors'] as const).flatMap(layer => found[layer]!.files));
  const unvendored = listed.get('unvendored')!;
  expect(Object.keys(unvendored.packages)).toEqual([]);
  const rest = sources(K8, 'src').filter(file => !vendored.has(file));
  const covers = (entry: string, file: string) => entry.endsWith('/') ? file.startsWith(entry) : file === entry;
  expect(rest.filter(file => !unvendored.files.some(entry => covers(entry, file))), 'add to a layer or to unvendored in src/VENDOR.md').toEqual([]);
  expect(unvendored.files.filter(entry => !rest.some(file => covers(entry, file))), 'stale unvendored entry in src/VENDOR.md').toEqual([]);
});

it('declares every K8 package, and imports only published K4 entries', () => {
  const { listed, k8 } = vendorLayers();
  const declared = new Set(Object.keys({ ...k8.dependencies, ...k8.devDependencies }));
  const used = (['rules', 'host', 'vectors'] as const).flatMap(layer => Object.keys(listed.get(layer)!.packages));
  expect(used.filter(spec => !spec.startsWith('node:') && !declared.has(packageName(spec)))).toEqual([]);
  // Each K4 entry that K8 imports exists in the server exports table.
  const serverExports = Object.keys(packageJson(SERVER).exports).map(key => key === '.' ? '@byok-sdk/server' : `@byok-sdk/server/${key.slice(2)}`);
  expect(used.filter(spec => spec.startsWith('@byok-sdk/server/execution-core') && !serverExports.includes(spec))).toEqual([]);
});

it('finds a missing and a stale entry, and a K4 name outside the list', () => {
  const found: Graph = { files: ['src/rules/a.ts', 'src/rules/b.ts'], packages: { k4: ['hash', 'taskId'], vitest: ['expect'] } };
  const listed = manifest(['```vendor rules', 'src/rules/a.ts', 'src/rules/c.ts', 'k4: hash', 'vitest', '```', ''].join('\n')).get('rules')!;
  expect(compare(listed, found)).toEqual({ files: ['src/rules/a.ts', 'src/rules/c.ts'], packages: { k4: ['hash'], vitest: ['expect'] } });
  expect(compare(listed, found)).not.toEqual(found);
});

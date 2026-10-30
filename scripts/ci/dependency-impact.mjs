import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`Reviewed CI mapping required: ${message}`); };
const read = (cwd, dir) => JSON.parse(readFileSync(resolve(cwd, dir, 'package.json'), 'utf8'));
const specs = record => Object.assign({}, ...fields.map(field => record?.[field] ?? {}));
const external = (name, spec) => typeof spec === 'string' && spec.length > 0
  && !name.startsWith('@byok-sdk/') && !/^(workspace:|file:|link:)/.test(spec);

function workspaces(cwd) {
  return ['packages', 'examples'].flatMap(prefix => existsSync(resolve(cwd, prefix))
    ? readdirSync(resolve(cwd, prefix)).map(name => `${prefix}/${name}`)
      .filter(dir => existsSync(resolve(cwd, dir, 'package.json'))) : []);
}

/** Version changes on existing external edges are data, not a per-upgrade CI exception.
 * Other manifest fields and workspace-edge changes retain their owning checks.
 */
export function normalizeDependencyVersions(before, after, path, cwd) {
  let changed = false;
  if (path === 'packages/client/package.json' && before.byok?.piRuntimePin !== after.byok?.piRuntimePin) {
    const name = '@earendil-works/pi-coding-agent';
    if (before.byok?.piRuntimePin !== before.dependencies?.[name]
      || after.byok?.piRuntimePin !== after.dependencies?.[name]) fail('Pi runtime metadata must match its dependency pin');
    after.byok.piRuntimePin = before.byok.piRuntimePin;
  }
  for (const field of [...fields, ...(path === 'package.json' ? ['overrides'] : [])]) {
    for (const [name, previous] of Object.entries(before[field] ?? {})) {
      const current = after[field]?.[name];
      if (previous !== current && external(name, previous) && external(name, current)) {
        after[field][name] = previous;
        changed = true;
      }
    }
  }
  if (!changed) return [];
  return path === 'package.json' ? workspaces(cwd) : [path.slice(0, -'/package.json'.length)];
}

function packageName(row) {
  if (!Array.isArray(row) || typeof row[0] !== 'string') fail('invalid resolved package row');
  const match = /^((?:@[^/@]+\/)?[^/@]+)@/.exec(row[0]);
  if (!match) fail('unrecognized resolved package identity');
  return match[1];
}

/** Lock rows, including nested versions, are the dependency authority. Unioning
 * all resolved versions of a package intentionally qualifies all its consumers.
 * It never treats an unowned changed row as evidence of no impact.
 */
export function dependencyLockImpact(before, after, { cwd }) {
  if (![before, after].every(lock => plain(lock.workspaces) && plain(lock.packages))) fail('invalid Bun lock shape');
  if (!isDeepStrictEqual(Object.keys(before.workspaces).sort(), Object.keys(after.workspaces).sort())) fail('workspace topology changed');
  const roots = new Set();
  for (const [dir, record] of Object.entries(after.workspaces)) {
    if (dir && !/^(packages|examples)\/[^/]+$/.test(dir)) fail('invalid workspace path');
    const manifest = read(cwd, dir);
    if (dir.startsWith('examples/') && manifest.private !== true) fail('example workspace must stay private');
    if (record.name !== manifest.name && dir !== '') fail('lock workspace name differs from manifest');
    if (dir && record.version !== manifest.version) fail('lock version differs from workspace manifest');
    for (const field of fields) {
      if (!isDeepStrictEqual(record[field] ?? {}, manifest[field] ?? {})) fail(`lock ${dir || 'root'} ${field} differs from manifest`);
    }
    if (!isDeepStrictEqual(specs(before.workspaces[dir]), specs(record))) roots.add(dir);
    const old = structuredClone(before.workspaces[dir]), next = structuredClone(record);
    for (const value of [old, next]) { delete value.version; for (const field of fields) delete value[field]; }
    if (!isDeepStrictEqual(old, next)) fail('lock workspace changes more than dependency fields');
  }
  const affected = new Set();
  const changedPackages = new Set();
  const edges = new Map();
  for (const key of new Set([...Object.keys(before.packages), ...Object.keys(after.packages)])) {
    const old = before.packages[key], next = after.packages[key];
    for (const row of [old, next].filter(Boolean)) {
      const name = packageName(row);
      // Bun records tarball metadata at index 1 and registry metadata at index 2.
      const metadata = row.find(plain) ?? {};
      const deps = edges.get(name) ?? new Set();
      for (const dep of Object.keys(specs(metadata))) deps.add(dep);
      edges.set(name, deps);
      if (!isDeepStrictEqual(old, next)) { affected.add(name); changedPackages.add(name); }
      // Alias entries use their dependency key while their row names the real package.
      if (key !== name && !key.includes('/' + name)) {
        const aliases = edges.get(key) ?? new Set(); aliases.add(name); edges.set(key, aliases);
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, deps] of edges) if (!affected.has(name) && [...deps].some(dep => affected.has(dep))) {
      affected.add(name); changed = true;
    }
  }
  for (const lock of [before, after]) for (const [dir, record] of Object.entries(lock.workspaces)) {
    if (Object.keys(specs(record)).some(name => affected.has(name))) roots.add(dir);
  }
  const reachable = new Set();
  const visit = name => {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const dep of edges.get(name) ?? []) visit(dep);
  };
  for (const lock of [before, after]) for (const record of Object.values(lock.workspaces)) {
    for (const name of Object.keys(specs(record))) visit(name);
  }
  if ([...changedPackages].some(name => !reachable.has(name))) fail('changed resolved packages have no declaring workspace');
  for (const lock of [before, after]) {
    delete lock.packages; delete lock.workspaces;
  }
  if (!isDeepStrictEqual(before.overrides, after.overrides)) roots.add('');
  if (!isDeepStrictEqual(after.overrides ?? {}, read(cwd, '').overrides ?? {})) fail('lock overrides differ from root manifest');
  delete before.overrides; delete after.overrides;
  if (!isDeepStrictEqual(before, after)) fail('lock changes more than dependency fields');
  return [...(roots.has('') ? workspaces(cwd) : roots)].sort();
}

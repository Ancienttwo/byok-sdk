import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { scanModule } from './module-scan.mjs';

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const posix = value => value.split(path.sep).join('/');
const sorted = values => [...new Set(values)].sort();
const inside = (directory, file) => file === directory || file.startsWith(directory + path.sep);
const packageName = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
const runtimeFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const START = '<!-- BEGIN generated: api-surface/entries.json -->';
const END = '<!-- END generated: api-surface/entries.json -->';

export function publicPackages(root) {
  return readdirSync(path.join(root, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(root, 'packages', entry.name, 'package.json')))
    .map(entry => {
      const directory = path.join(root, 'packages', entry.name);
      return { directory, manifest: readJson(path.join(directory, 'package.json')), workspace: true };
    }).filter(pkg => pkg.manifest.private !== true)
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

// Every conditional leaf remains visible in coverage. No guessed default
// target and no handwritten list of subpaths is used by either consumer.
function leaves(value, conditions = []) {
  if (typeof value === 'string') return [{ target: value, conditions }];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('entry targets must be strings or conditional maps');
  return Object.entries(value).flatMap(([condition, target]) => leaves(target, [...conditions, condition]));
}

export function manifestEntries(root) {
  const entries = [];
  for (const pkg of publicPackages(root)) {
    const add = (kind, specifier, value) => {
      const targets = leaves(value), types = targets.filter(item => item.conditions.includes('types'));
      const runtime = targets.filter(item => !item.conditions.includes('types'));
      for (const item of runtime) {
        if (!item.target.startsWith('./')) throw new Error(`${pkg.manifest.name} ${specifier}: target must be package-relative`);
        const base = kind === 'bin' ? `bin:${specifier}` : kind === 'imports' ? `${pkg.manifest.name}${specifier}`
          : pkg.manifest.name + (specifier === '.' ? '' : specifier.slice(1));
        const id = runtime.length === 1 ? base : `${base}[${item.conditions.join('.')}]`;
        const target = path.resolve(pkg.directory, item.target);
        if (!inside(pkg.directory, target)) throw new Error(`${id}: target leaves package`);
        entries.push({ id, kind, specifier, pkg, target, conditions: item.conditions,
          types: sorted(types.map(item => posix(path.relative(root, path.resolve(pkg.directory, item.target))))) });
      }
      if (!runtime.length) throw new Error(`${pkg.manifest.name} ${specifier}: no runtime target`);
    };
    const exports = pkg.manifest.exports;
    if (typeof exports === 'string' || (exports && Object.keys(exports).every(key => !key.startsWith('.')))) add('exports', '.', exports);
    else for (const [specifier, value] of Object.entries(exports ?? {})) add('exports', specifier, value);
    const bins = typeof pkg.manifest.bin === 'string' ? { [packageName(pkg.manifest.name).split('/').at(-1)]: pkg.manifest.bin } : pkg.manifest.bin;
    for (const [specifier, value] of Object.entries(bins ?? {})) add('bin', specifier, value);
    for (const [specifier, value] of Object.entries(pkg.manifest.imports ?? {})) add('imports', specifier, value);
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

function selectTarget(value, conditions) {
  if (value === null) throw new Error('blocked export target');
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('unsupported export target');
  for (const [condition, target] of Object.entries(value)) {
    if (condition === 'default' || conditions.has(condition)) {
      const selected = selectTarget(target, conditions);
      if (selected !== undefined) return selected;
    }
  }
  return undefined;
}

function mappedTarget(map, key, conditions) {
  if (typeof map === 'string') return key === '.' ? map : undefined;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('unsupported exports/imports map');
  if (Object.keys(map).every(key => !key.startsWith('.') && !key.startsWith('#'))) return key === '.' ? selectTarget(map, conditions) : undefined;
  if (Object.hasOwn(map, key)) return selectTarget(map[key], conditions);
  const patterns = Object.keys(map).filter(pattern => pattern.includes('*')).sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
  for (const pattern of patterns) {
    const [prefix, suffix] = pattern.split('*');
    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) {
      return selectTarget(map[pattern], conditions)?.replaceAll('*', key.slice(prefix.length, key.length - suffix.length));
    }
  }
  return undefined;
}

export function createWalker(root) {
  const workspace = new Map(publicPackages(root).map(pkg => [pkg.manifest.name, pkg]));
  const tokenCache = new Map(), packageCache = new Map(), closureCache = new Map();
  function installedPackage(from, name) {
    if (from.manifest.name === name) return from;
    let directory = from.directory;
    for (;;) {
      const candidate = path.join(directory, 'node_modules', name);
      if (existsSync(path.join(candidate, 'package.json'))) {
        const real = realpathSync(candidate);
        if (!packageCache.has(real)) packageCache.set(real, { directory: real, manifest: readJson(path.join(real, 'package.json')), workspace: false });
        return packageCache.get(real);
      }
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`cannot resolve installed package ${name} from ${from.manifest.name}`);
      directory = parent;
    }
  }
  function fileAt(base, pkg) {
    const file = [base, base + '.js', base + '.mjs', base + '.cjs', base + '.json', path.join(base, 'index.js')]
      .find(file => existsSync(file) && statSync(file).isFile());
    if (!file) throw new Error(`missing module ${posix(path.relative(root, base))}`);
    const real = realpathSync(file);
    const boundary = pkg.workspace && !file.endsWith('/package.json') ? path.join(pkg.directory, 'dist') : pkg.directory;
    if (!inside(realpathSync(boundary), real)) throw new Error(`${posix(path.relative(root, file))}: module leaves ${pkg.workspace ? 'dist' : 'package'}`);
    return real;
  }
  function resolve(fromFile, from, edge) {
    const specifier = edge.specifier;
    if (isBuiltin(specifier) || specifier === 'cloudflare:workers') return null;
    if (specifier.startsWith('.')) return { pkg: from, file: fileAt(path.resolve(path.dirname(fromFile), specifier), from) };
    const conditions = new Set(['node', edge.require ? 'require' : 'import']);
    if (specifier.startsWith('#')) {
      const target = mappedTarget(from.manifest.imports, specifier, conditions);
      if (target === undefined) throw new Error(`${from.manifest.name}: unresolvable imports entry ${specifier}`);
      return target.startsWith('./') ? { pkg: from, file: fileAt(path.resolve(from.directory, target), from) }
        : resolve(fromFile, from, { ...edge, specifier: target });
    }
    const name = packageName(specifier);
    if (from.workspace && name !== from.manifest.name && !runtimeFields.some(field => Object.hasOwn(from.manifest[field] ?? {}, name))) {
      throw new Error(`${from.manifest.name}: undeclared runtime dependency ${specifier}`);
    }
    const pkg = workspace.get(name) ?? installedPackage(from, name);
    const subpath = specifier === name ? '.' : '.' + specifier.slice(name.length);
    const target = pkg.manifest.exports !== undefined ? mappedTarget(pkg.manifest.exports, subpath, conditions)
      : subpath === '.' ? (pkg.manifest.main ?? './index.js') : subpath;
    if (target === undefined) throw new Error(`${from.manifest.name}: unexported specifier ${specifier}`);
    if (typeof target !== 'string' || path.isAbsolute(target) || (pkg.manifest.exports !== undefined && !target.startsWith('./'))) {
      throw new Error(`${specifier}: invalid package export target`);
    }
    return { pkg, file: fileAt(path.resolve(pkg.directory, target), pkg) };
  }
  return entry => {
    if (closureCache.has(entry.target)) return closureCache.get(entry.target);
    const seen = new Set(), bare = [], lazy = [], third = [], builtins = [], codegen = [];
    let bytes = 0;
    function visit(file, pkg) {
      if (seen.has(file)) return;
      seen.add(file);
      if (pkg.workspace) bytes += statSync(file).size;
      else third.push(pkg.manifest.name);
      if (file.endsWith('.json')) return;
      if (!/\.(?:js|mjs|cjs)$/.test(file)) throw new Error(`unsupported runtime module ${file}`);
      if (!tokenCache.has(file)) tokenCache.set(file, scanModule(readFileSync(file, 'utf8')));
      const scan = tokenCache.get(file);
      const display = pkg.workspace ? posix(path.relative(root, file)) : `${pkg.manifest.name}/${posix(path.relative(pkg.directory, file))}`;
      for (const hit of scan.codegen) codegen.push({ file: display, ...hit });
      for (const edge of scan.lazyImports) {
        if (pkg.workspace) lazy.push(edge.specifier);
        if (isBuiltin(edge.specifier)) builtins.push(edge.specifier);
        // Validate literal workspace lazy edges without counting their bytes.
        if (pkg.workspace && !isBuiltin(edge.specifier)) resolve(file, pkg, edge);
      }
      for (const edge of scan.imports) {
        if (pkg.workspace && !edge.specifier.startsWith('.')) bare.push(edge.specifier);
        if (isBuiltin(edge.specifier)) builtins.push(edge.specifier);
        const resolved = resolve(file, pkg, edge);
        if (resolved) visit(resolved.file, resolved.pkg);
      }
    }
    visit(fileAt(entry.target, entry.pkg), entry.pkg);
    const result = { bytes, bareImports: sorted(bare), lazyImports: sorted(lazy), thirdParty: sorted(third),
      nodeBuiltins: sorted(builtins), codegen: codegen.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule)) };
    closureCache.set(entry.target, result);
    return result;
  };
}

export function renderEntryTable(contract) {
  const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows = Object.entries(contract).map(([id, record]) => `| \`${escape(id)}\` | ${escape(record.policy.purpose)} | ${record.facts.thirdParty.map(name => `\`${name}\``).join(', ') || '—'} | ${record.policy.zod ? 'allowed' : 'forbidden'} | ${record.policy.budgetBytes} B |`);
  return `${START}\n\nWorkspace static closure budgets exclude third-party bytes, sourcemaps and literal lazy imports.\nThird-party dependencies and code-generation evidence follow static dependency edges; these are build facts, not a CSP sandbox guarantee.\n\n| Import / command | Purpose | Third-party dependencies | Zod | Budget |\n| --- | --- | --- | --- | ---: |\n${rows.join('\n')}\n\n${END}`;
}

export function checkEntryClosure(root, { update = false } = {}) {
  const file = path.join(root, 'api-surface', 'entries.json');
  if (!existsSync(file)) throw new Error('api-surface/entries.json is missing; author entry policies before --update');
  const contract = readJson(file), entries = manifestEntries(root), walk = createWalker(root), failures = [], measured = [], updated = {};
  const ids = new Set(entries.map(entry => entry.id));
  for (const id of Object.keys(contract)) if (!ids.has(id)) failures.push(`${id}: orphan entry policy`);
  for (const entry of entries) {
    try {
      const record = contract[entry.id];
      if (!record) throw new Error('missing entry policy; --update cannot create or infer policy');
      const policy = record.policy;
      if (!policy || typeof policy.purpose !== 'string' || !policy.purpose.trim()
        || !Number.isSafeInteger(policy.budgetBytes) || policy.budgetBytes < 0
        || ['zod', 'codegen', 'nodeBuiltins'].some(key => typeof policy[key] !== 'boolean')) throw new Error('invalid entry policy');
      for (const type of entry.types) {
        const target = path.resolve(root, type);
        if (!inside(path.join(entry.pkg.directory, 'dist'), target) || !existsSync(target)) throw new Error(`missing or escaped declaration target ${type}`);
      }
      const result = walk(entry);
      measured.push({ id: entry.id, bytes: result.bytes, budgetBytes: policy.budgetBytes });
      const via = result.bareImports.join(', ');
      if (!policy.zod && result.thirdParty.includes('zod')) throw new Error(`zod is forbidden; specifiers: ${via}`);
      if (!policy.codegen && result.codegen.length) throw new Error(`code generation is forbidden: ${JSON.stringify(result.codegen.slice(0, 3))}; specifiers: ${via}`);
      if (!policy.nodeBuiltins && result.nodeBuiltins.length) throw new Error(`Node builtins are forbidden: ${result.nodeBuiltins.join(', ')}`);
      if (result.bytes > policy.budgetBytes) throw new Error(`closure ${result.bytes} bytes exceeds budget ${policy.budgetBytes}`);
      const { bytes, ...facts } = result;
      const next = { kind: entry.kind, policy, facts: { target: posix(path.relative(root, entry.target)), conditions: entry.conditions, types: entry.types, ...facts } };
      updated[entry.id] = next;
      if (!update && JSON.stringify(record) !== JSON.stringify(next)) throw new Error('entry facts drifted; review then run check:api-surface -- --update');
    } catch (error) { failures.push(`${entry.id}: ${error.message}`); }
  }
  if (failures.length) return { failures, measured };
  const readmeFile = path.join(root, 'README.md'), readme = readFileSync(readmeFile, 'utf8');
  const start = readme.indexOf(START), end = readme.indexOf(END);
  if (start < 0 || end < start || readme.indexOf(START, start + START.length) >= 0 || readme.indexOf(END, end + END.length) >= 0) {
    return { failures: ['README.md: exactly one generated entries table region is required'], measured };
  }
  const table = renderEntryTable(updated);
  const nextReadme = readme.slice(0, start) + table + readme.slice(end + END.length);
  if (!update && nextReadme !== readme) failures.push('README.md: entry dependency table drifted from entries.json');
  if (update) {
    writeFileSync(file, JSON.stringify(updated, null, 2) + '\n');
    writeFileSync(readmeFile, nextReadme);
  }
  return { failures, measured };
}

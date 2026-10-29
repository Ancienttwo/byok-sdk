import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { API } from 'typescript/unstable/sync';
import { SyntaxKind as K } from 'typescript/unstable/ast';

const sourcePattern = /\.(?:ts|tsx)$/;
export function sourceFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', 'vendor', '__tests__'].includes(entry.name)) return [];
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(file)
      : sourcePattern.test(file) && !/\.(?:test|spec|d)\.(?:ts|tsx)$/.test(file) ? [file] : [];
  }).sort();
}

/** AST distinctions are deliberately tested against the installed TS API. */
export function extractModuleEdges(file) {
  const edges = [];
  const allTypes = clause => clause?.kind === K.NamedImports || clause?.kind === K.NamedExports
    ? clause.elements.length > 0 && clause.elements.every(member => member.isTypeOnly) : false;
  const add = (node, literal, type, form) => {
    if (literal?.kind === K.StringLiteral || literal?.kind === K.NoSubstitutionTemplateLiteral) {
      edges.push({ specifier: literal.text, kind: type ? 'type' : 'value', form, start: node.pos });
    }
  };
  const visit = node => {
    if (node.kind === K.ImportDeclaration) {
      const clause = node.importClause;
      add(node, node.moduleSpecifier, clause?.isTypeOnly || (!clause?.name && allTypes(clause?.namedBindings)), 'import');
    } else if (node.kind === K.ExportDeclaration) {
      add(node, node.moduleSpecifier, node.isTypeOnly || allTypes(node.exportClause), 'export');
    } else if (node.kind === K.ImportType) {
      add(node, node.argument?.literal, true, 'import-type');
    } else if (node.kind === K.CallExpression && node.expression.kind === K.ImportKeyword) {
      add(node, node.arguments[0], false, 'dynamic-import');
    } else if (node.kind === K.CallExpression && node.expression.kind === K.Identifier && node.expression.text === 'require') {
      add(node, node.arguments[0], false, 'require');
    } else if (node.kind === K.ImportEqualsDeclaration) {
      add(node, node.moduleReference?.expression, node.isTypeOnly, 'import-equals');
    }
    node.forEachChild(visit);
  };
  visit(file);
  return { edges, barrel: file.statements.length > 0 && file.statements.every(n => n.kind === K.ExportDeclaration) };
}

/** One virtual project avoids changing package tsconfigs or depending on dist output. */
export function parseSources(root, files) {
  const config = path.join(root, '.dependency-graph.tsconfig.json').split(path.sep).join('/');
  const api = new API({ cwd: root, fs: {
    readFile: file => file === config ? JSON.stringify({ compilerOptions: { noResolve: true, noLib: true }, files }) : undefined,
    fileExists: file => file === config ? true : undefined,
  } });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    const program = snapshot.getProject(config)?.program;
    if (!program) throw new Error('TypeScript did not open the dependency graph project');
    return new Map(files.map(file => {
      const ast = program.getSourceFile(file);
      if (!ast) throw new Error(`TypeScript did not parse ${file}`);
      return [file, extractModuleEdges(ast)];
    }));
  } finally { api.close(); }
}

const allowed = {
  core: [], protocol: [], 'cloud-do': [], cloud: ['core', 'protocol'],
  server: ['core', 'protocol', 'cloud'], 'cloud-dataplane': ['core', 'protocol', 'cloud'],
  'ui-runtime': ['core', 'protocol', 'cloud'], client: ['core', 'protocol'], keys: ['core'],
  conformance: ['core', 'protocol', 'cloud', 'testkit'], testkit: ['core', 'protocol'],
};
export function packageDirection(from, to) {
  return from === to || allowed[from]?.includes(to) === true;
}
export function directoryLayer(pkg, file) {
  const dir = file.split('/')[0];
  if (pkg === 'client') {
    if (['bin', 'lifecycle', 'diagnostics', 'testing'].includes(dir)) return 3;
    if (dir === 'daemon') return 2;
    if (['adapters', 'runtime', 'subagents', 'agent-memory', 'mcp', 'mcp-server'].includes(dir)) return 1;
    return 0;
  }
  if (pkg === 'cloud') {
    if (dir === 'composition') return 5;
    if (file === 'cloud.ts') return 4;
    if (['api', 'handlers', 'router'].includes(dir)) return 3;
    if (dir === 'stores') return 2;
    if (!file.includes('/')) return 1;
    return 0;
  }
  return undefined;
}

/** SCCs identify cycles; baseline each internal edge so an enlarged SCC cannot hide an edge. */
export function cycleEdges(graph) {
  let next = 0;
  const indices = new Map(), low = new Map(), stack = [], active = new Set(), result = [];
  const visit = file => {
    indices.set(file, next); low.set(file, next++); stack.push(file); active.add(file);
    for (const target of graph.get(file) ?? []) {
      if (!indices.has(target)) { visit(target); low.set(file, Math.min(low.get(file), low.get(target))); }
      else if (active.has(target)) low.set(file, Math.min(low.get(file), indices.get(target)));
    }
    if (low.get(file) !== indices.get(file)) return;
    const component = new Set();
    let member;
    do { member = stack.pop(); active.delete(member); component.add(member); } while (member !== file);
    for (const from of component) for (const to of graph.get(from) ?? []) {
      if (component.has(to) && (component.size > 1 || from === to)) result.push([from, to]);
    }
  };
  for (const file of graph.keys()) if (!indices.has(file)) visit(file);
  return result;
}

function resolveSource(file, sources) {
  const stem = file.replace(/\.(?:js|mjs|cjs)$/, '');
  return [file, `${stem}.ts`, `${stem}.tsx`, `${file}/index.ts`, `${file}/index.tsx`].find(p => sources.has(p));
}
function exportTarget(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return exportTarget(value.import ?? value.default);
}
/** Convert native filesystem paths once, before they enter the rule graph. */
export function graphSourcePath(root, file, nativePath = path) {
  return nativePath.relative(root, file).split(nativePath.sep).join('/');
}
export function sourceOwner(file, packages) {
  return [...packages.values()].find(pkg => file.startsWith(`${pkg.root}/src/`));
}
function packageSourcePath(pkg, file) {
  return path.posix.relative(`${pkg.root}/src`, file);
}
export function inspectRepository(root) {
  const packages = new Map();
  for (const dir of readdirSync(path.join(root, 'packages'))) {
    const manifestFile = path.join(root, 'packages', dir, 'package.json');
    if (!existsSync(manifestFile)) continue;
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    packages.set(manifest.name, { dir, manifest, root: graphSourcePath(root, path.dirname(manifestFile)) });
  }
  const files = [...packages.values()].flatMap(p => sourceFiles(path.join(root, p.root, 'src')));
  const sources = new Map([...parseSources(root, files)].map(([file, parsed]) => [graphSourcePath(root, file), parsed]));
  const violations = new Set(), graph = new Map();
  const publicEntries = new Set();
  for (const pkg of packages.values()) for (const value of Object.values(pkg.manifest.exports ?? {})) {
    const entry = exportTarget(value);
    if (entry?.startsWith('./dist/')) {
      const source = resolveSource(path.posix.join(pkg.root, 'src', entry.slice(7)), sources);
      if (source) publicEntries.add(source);
    }
  }
  const owner = file => sourceOwner(file, packages);
  const report = (rule, from, to) => violations.add(`${rule}: ${from} -> ${to}`);
  for (const pkg of packages.values()) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg.manifest[field] ?? {})) {
        const target = packages.get(name);
        if (target && !packageDirection(pkg.dir, target.dir)) report('package', `${pkg.root}/package.json#${field}`, name);
      }
    }
  }
  for (const [file, parsed] of sources) {
    const pkg = owner(file), from = file;
    graph.set(file, new Set());
    for (const edge of parsed.edges) {
      if (edge.kind !== 'value') continue;
      const name = edge.specifier.startsWith('@') ? edge.specifier.split('/').slice(0, 2).join('/') : edge.specifier.split('/')[0];
      const targetPackage = packages.get(name);
      let target;
      if (edge.specifier.startsWith('.')) {
        target = resolveSource(path.posix.join(path.posix.dirname(file), edge.specifier), sources);
        // Local JSON and JS assets are outside the documented TS graph.
        if (!target && !['', '.js', '.mjs', '.cjs', '.json'].some(ext => existsSync(path.resolve(root, path.posix.dirname(file), edge.specifier + ext)))) throw new Error(`${from}: unresolved source ${edge.specifier}`);
      } else if (targetPackage) {
        if (pkg !== targetPackage && !pkg.manifest.dependencies?.[name]) report('manifest', from, name);
        if (!packageDirection(pkg.dir, targetPackage.dir)) report('source-package', from, name);
        const subpath = edge.specifier.slice(name.length);
        const entry = exportTarget(targetPackage.manifest.exports?.[subpath ? `.${subpath}` : '.']);
        if (entry?.startsWith('./dist/')) target = resolveSource(path.posix.join(targetPackage.root, 'src', entry.slice(7)), sources);
        else if (entry) target = resolveSource(path.posix.join(targetPackage.root, entry), sources);
        if (!target && !entry?.endsWith('.json')) throw new Error(`${from}: unresolved workspace export ${edge.specifier}`);
      } else if (name.startsWith('@byok-sdk/')) throw new Error(`${from}: unknown workspace package ${name}`);
      if (!target) continue;
      graph.get(file).add(target);
      const targetOwner = owner(target);
      if (targetOwner !== pkg) {
        if (!pkg.manifest.dependencies?.[targetOwner.manifest.name]) report('manifest', from, targetOwner.manifest.name);
        if (!packageDirection(pkg.dir, targetOwner.dir)) report('source-package', from, targetOwner.manifest.name);
      }
    }
  }
  // Follow value re-exports when a lower layer imports an entry barrel; an
  // entry's directory must not conceal the layer of its runtime closure.
  const destinations = (file, seen = new Set()) => {
    if (seen.has(file)) return [];
    seen.add(file);
    if (!sources.get(file)?.barrel) return [file];
    return [...graph.get(file) ?? []].flatMap(target => destinations(target, seen));
  };
  for (const [file, targets] of graph) {
    if (publicEntries.has(file) && sources.get(file).barrel) continue;
    const pkg = owner(file);
    const sourceLayer = directoryLayer(pkg.dir, packageSourcePath(pkg, file));
    for (const target of targets) for (const resolved of destinations(target)) {
      if (owner(resolved) !== pkg) continue;
      const targetLayer = directoryLayer(pkg.dir, packageSourcePath(pkg, resolved));
      if (sourceLayer < targetLayer) report('directory', file, resolved);
    }
  }
  for (const [from, to] of cycleEdges(graph)) {
    if (['client', 'cloud'].includes(owner(from).dir)) report('cycle', from, to);
  }
  return [...violations].sort();
}

export function compareBaseline(actual, baseline) {
  if (!Array.isArray(baseline) || baseline.some(v => typeof v !== 'string') || new Set(baseline).size !== baseline.length) {
    throw new Error('dependency baseline must be an array of unique violation identities');
  }
  const current = new Set(actual), recorded = new Set(baseline);
  return [
    ...actual.filter(v => !recorded.has(v)).map(v => `new ${v}`),
    ...baseline.filter(v => !current.has(v)).map(v => `stale baseline (remove): ${v}`),
  ];
}
export function compareBaselineHistory(baseline, previous) {
  compareBaseline([], baseline); compareBaseline([], previous);
  const allowed = new Set(previous);
  return baseline.filter(edge => !allowed.has(edge)).map(edge => `baseline must shrink: ${edge}`);
}

export function checkDependencyDirection(root) {
  const file = path.join(root, 'scripts/architecture/dependency-baseline.json');
  const baseline = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const errors = compareBaseline(inspectRepository(root), baseline);
  if (process.env.CI_BASE) {
    const base = process.env.CI_BASE;
    if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('CI_BASE must be an exact commit');
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('cat-file', '-e', `${base}^{commit}`);
    const name = 'scripts/architecture/dependency-baseline.json';
    if (git('ls-tree', '--name-only', base, '--', name)) {
      errors.push(...compareBaselineHistory(baseline, JSON.parse(git('show', `${base}:${name}`))));
    } else if (git('ls-tree', '--name-only', base, '--', 'scripts/architecture/dependency-graph.mjs')) {
      errors.push(...compareBaselineHistory(baseline, []));
    }
  }
  return errors;
}

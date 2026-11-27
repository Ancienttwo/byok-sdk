import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseBunLock } from '../release/pi-runtime-identity.mjs';
import { dependencyLockImpact, normalizeDependencyVersions } from './dependency-impact.mjs';
import { admitDocumentationScripts } from './documentation-checks.mjs';

// The nine published manifests. A contract test keeps this list equal to the
// non-private packages/*/package.json files.
export const publicManifests = Object.freeze([
  'bot-collaboration', 'client', 'cloud', 'cloud-dataplane', 'core', 'keys', 'protocol', 'server', 'ui-runtime',
].map(name => `packages/${name}/package.json`));

const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const privateImportConditions = new Set(['types', 'node', 'import', 'require', 'default']);
const safeSegment = segment => /^[a-z0-9._-]+$/i.test(segment)
  && !segment.endsWith('.') && segment.toLowerCase() !== 'node_modules';

function privateDistTarget(value) {
  if (typeof value === 'string') {
    return value.startsWith('./dist/') && value.slice('./dist/'.length).split('/').every(safeSegment);
  }
  if (!plain(value)) return false;
  const conditions = Object.entries(value);
  return conditions.length > 0 && conditions.every(([condition, target]) =>
    privateImportConditions.has(condition) && privateDistTarget(target));
}

// Built outputs need not exist during selection. Admit only new exact aliases
// whose targets stay lexically in dist. The build gate resolves the targets.
function admitPrivateDistImports(before, after) {
  if ((before.imports !== undefined && !plain(before.imports)) || !plain(after.imports)) return;
  const entries = Object.entries(after.imports);
  let admitted = false;
  for (const [key, value] of entries) {
    if (key.startsWith('#byok-') && key.slice('#byok-'.length).split('/').every(safeSegment)
      && !Object.hasOwn(before.imports ?? {}, key) && privateDistTarget(value)) {
      delete after.imports[key];
      admitted = true;
    }
  }
  if (admitted && before.imports === undefined && Object.keys(after.imports).length === 0) delete after.imports;
  return admitted;
}

// #793 D2 (owner O8): the private hosted (H) example. Its manifest has a fixed
// shape. It may only reuse workspaces and dependency specs that another
// workspace manifest already declares, so it adds no package and moves no version.
// #794 D3: the private Worker composition of H follows the same rule.
const HOSTED = Object.freeze({ dir: 'examples/hosted-bot-collaboration', name: '@byok-sdk/example-hosted-bot-collaboration' });
const HOSTED_WORKER = Object.freeze({ dir: 'examples/hosted-bot-collaboration-worker', name: '@byok-sdk/example-hosted-bot-collaboration-worker' });
const PRIVATE_HOSTED = Object.freeze([HOSTED, HOSTED_WORKER]);
const HOSTED_FIELDS = new Set(['name', 'version', 'private', 'type', 'description', 'scripts', 'dependencies', 'devDependencies']);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'];
// #1845: K8 is the published package @byok-sdk/bot-collaboration. Its manifest
// has one reviewed shape: the four built entries, the published files, and a
// runtime closure of published packages only. A private example such as the K4
// demo Host may be a devDependency, never a runtime or peer dependency, so an
// install never needs a package that is not on npm.
const K8 = Object.freeze({ dir: 'packages/bot-collaboration', name: '@byok-sdk/bot-collaboration' });
const K8_FIELDS = new Set(['name', 'version', 'type', 'description', 'license', 'repository', 'bugs', 'homepage', 'engines', 'sideEffects',
  'main', 'module', 'types', 'exports', 'files', 'publishConfig', 'scripts', 'dependencies', 'peerDependencies', 'peerDependenciesMeta', 'devDependencies']);
const K8_PUBLISHED = Object.freeze({
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/Ancienttwo/byok-sdk.git', directory: 'packages/bot-collaboration' },
  bugs: { url: 'https://github.com/Ancienttwo/byok-sdk/issues' },
  homepage: 'https://github.com/Ancienttwo/byok-sdk#readme',
  engines: { node: '>=24.22.3' },
  files: ['dist', 'README.md', 'LICENSE'],
  publishConfig: { access: 'public' },
});
const K8_EXPORTS = Object.freeze({
  '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  './host-kit': { types: './dist/host-kit.d.ts', import: './dist/host-kit.js' },
  './rules': { types: './dist/rules/index.d.ts', import: './dist/rules/index.js' },
  './testing': { types: './dist/testing.d.ts', import: './dist/testing.js' },
  './package.json': './package.json',
});
const K8_SCRIPTS = Object.freeze({ build: 'tsup && tsc -p tsconfig.build.json', typecheck: 'tsc --noEmit', test: 'vitest run', clean: 'rm -rf dist' });
const K8_CORE = '@byok-sdk/core';
const K8_RUNTIME = Object.freeze({ '@byok-sdk/client': 'workspace:*', [K8_CORE]: 'workspace:*', '@byok-sdk/protocol': 'workspace:*', '@byok-sdk/server': 'workspace:*' });
// `./testing` imports these; a Host that installs only `.` or `./rules` does not need them.
const K8_OPTIONAL_PEERS = Object.freeze(['@hono/node-server']);
/** The other workspace manifests, each with its dir. */
function otherWorkspaceManifests(cwd, self) {
  const manifests = [];
  for (const prefix of ['packages', 'examples']) {
    if (!existsSync(resolve(cwd, prefix))) continue;
    for (const name of readdirSync(resolve(cwd, prefix))) {
      const dir = `${prefix}/${name}`, file = resolve(cwd, dir, 'package.json');
      if (dir !== self && existsSync(file)) manifests.push({ dir, manifest: JSON.parse(readFileSync(file, 'utf8')) });
    }
  }
  return manifests;
}
function verifyHostedManifest(manifest, cwd, example) {
  if (!plain(manifest) || Object.keys(manifest).some(key => !HOSTED_FIELDS.has(key))
    || manifest.name !== example.name || manifest.private !== true || manifest.type !== 'module' || !version(manifest.version)
    || (manifest.description !== undefined && typeof manifest.description !== 'string')
    || !isDeepStrictEqual(manifest.scripts, { typecheck: 'tsc --noEmit', test: 'vitest run' })) {
    throw new Error('Reviewed CI mapping required: the hosted example manifest has an unreviewed shape');
  }
  const others = otherWorkspaceManifests(cwd, example.dir);
  // A third-party spec must come from a workspace outside the private hosted examples, so they cannot vouch for each other.
  const declaring = others.filter(other => !PRIVATE_HOSTED.some(hosted => hosted.dir === other.dir));
  for (const field of DEPENDENCY_FIELDS) {
    if (manifest[field] === undefined) continue;
    if (!plain(manifest[field])) throw new Error('Reviewed CI mapping required: the hosted example manifest has an unreviewed shape');
    for (const [name, spec] of Object.entries(manifest[field])) {
      const reused = name.startsWith('@byok-sdk/')
        ? spec === 'workspace:*' && others.some(other => other.manifest.name === name)
        : declaring.some(other => DEPENDENCY_FIELDS.some(declared => other.manifest[declared]?.[name] === spec));
      if (!reused) throw new Error(`Reviewed CI mapping required: the hosted example may only reuse a declared dependency spec (${name})`);
    }
  }
  return manifest;
}
/** Admits a private hosted example's own lock rows when they match its reviewed manifest. Every other lock byte stays compared. */
function admitHostedLock(before, after, cwd, example) {
  const entry = after.workspaces?.[example.dir];
  if (entry === undefined) return;
  const manifest = verifyHostedManifest(JSON.parse(readFileSync(resolve(cwd, example.dir, 'package.json'), 'utf8')), cwd, example);
  const expected = { name: manifest.name, version: manifest.version };
  for (const field of DEPENDENCY_FIELDS) if (manifest[field] !== undefined) expected[field] = manifest[field];
  const row = [`${example.name}@workspace:${example.dir}`];
  if (!isDeepStrictEqual(entry, expected) || !isDeepStrictEqual(after.packages?.[example.name], row)
    || (before.packages?.[example.name] !== undefined && !isDeepStrictEqual(before.packages[example.name], row))) {
    throw new Error('Reviewed CI mapping required: the hosted example lock rows differ from its manifest');
  }
  delete before.workspaces[example.dir]; delete after.workspaces[example.dir];
  if (before.packages) delete before.packages[example.name];
  delete after.packages[example.name];
}

// #1804: the desktop example's reviewed additions to the checked shape, exact:
// its Electron build and dev scripts and the two Electron devDependencies.
// #1830: the build bundles the React renderer with esbuild (the base 0.28.1
// spec), and React with its types joins the devDependencies (#1499 D9).
// #2286: the basic example keeps its dev script and the MCP example its source
// export, exact, so each can declare its @byok-sdk/core edge.
const REGISTERED_PRIVATE_ADDITIONS = Object.freeze({
  'examples/basic': Object.freeze({ scripts: Object.freeze({ dev: 'tsx server.ts' }) }),
  'examples/byok-mcp-server': Object.freeze({ fields: Object.freeze({ exports: Object.freeze({ '.': './src/index.ts' }) }) }),
  'examples/desktop-bot-app': Object.freeze({
    scripts: Object.freeze({
      build: "tsc -p tsconfig.build.json && esbuild src/renderer/index.tsx --bundle --format=esm --platform=browser --target=es2022 --minify --log-level=warning --outdir=dist/src/renderer --metafile=dist/renderer.meta.json && node -e \"require('node:fs').cpSync('src/renderer/index.html', 'dist/src/renderer/index.html')\"",
      // #1811: the one Host bundle (CommonJS under Node in dev, a SEA when packaged); dev runs it.
      'build:host': 'node scripts/package/bundle-host.mjs --format cjs',
      dev: 'bun run build && bun run build:host && electron dist/src/main/index.js',
      // #1811: the platform packages (electron-builder, #1499 D9).
      package: 'bun run build && node scripts/package/build.mjs',
      'test:keys-browser': 'node --test scripts/keys-submit.browser.mjs',
    }),
    dependencies: Object.freeze({ 'electron-updater': '6.8.11' }),
    devDependencies: Object.freeze({
      electron: '45.3.0', '@electron/fuses': '2.1.3', 'electron-builder': '26.18.0',
      react: '19.3.1', 'react-dom': '19.3.1', '@types/react': '19.3.0', '@types/react-dom': '19.3.0',
      // #1916: the codec-free ffmpeg download (checked against electron's pinned checksums) and its unzip, as electron's own install uses them (#1499 D7).
      '@electron/get': '5.1.0', '@electron-internal/extract-zip': '1.0.8',
    }),
  }),
});

/** A new private workspace is admitted only by the reviewed graph, with
 * executable checks and dependencies already declared by a base workspace.
 */
function verifyRegisteredPrivateManifest(manifest, dir, { base, cwd, workspaceGraph }) {
  const registration = workspaceGraph?.[dir];
  const additions = REGISTERED_PRIVATE_ADDITIONS[dir];
  const allowed = new Set([...HOSTED_FIELDS, 'license', 'engines', ...Object.keys(additions?.fields ?? {})]);
  if (!dir.startsWith('examples/') || !registration || !plain(manifest)
    || Object.keys(manifest).some(key => !allowed.has(key))
    || Object.entries(additions?.fields ?? {}).some(([key, value]) => !isDeepStrictEqual(manifest[key], value))
    || manifest.name !== registration.name || manifest.private !== true
    || manifest.type !== 'module' || !version(manifest.version)
    || !isDeepStrictEqual(manifest.scripts, { typecheck: 'tsc --noEmit', test: 'vitest run', ...additions?.scripts })) {
    throw new Error('Reviewed CI mapping required: new private workspace must be graph-registered with checked manifest shape');
  }
  const localEdges = [...new Set(DEPENDENCY_FIELDS.flatMap(field => Object.keys(manifest[field] ?? {}).filter(name => name.startsWith('@byok-sdk/'))))].sort();
  if (!isDeepStrictEqual(localEdges, [...registration.dependencies].sort())) throw new Error('New workspace edges differ from reviewed graph');
  verifyDeclaredSpecs(manifest, DEPENDENCY_FIELDS, { base, cwd }, additions);
  return manifest;
}

/** Each local edge names a base workspace by `workspace:*`; each external spec is one a base workspace already declares, or an exact registered addition. */
function verifyDeclaredSpecs(manifest, fields, { base, cwd }, additions) {
  const basePaths = execFileSync('git', ['ls-tree', '-r', '--name-only', base, '--', 'packages', 'examples'], { cwd, encoding: 'utf8' })
    .split('\n').filter(path => /^(packages|examples)\/[^/]+\/package\.json$/.test(path));
  const declarations = basePaths.map(path => JSON.parse(execFileSync('git', ['show', `${base}:${path}`], { cwd, encoding: 'utf8' })));
  for (const field of fields) {
    if (manifest[field] !== undefined && !plain(manifest[field])) throw new Error('Invalid new workspace dependencies');
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      const valid = name.startsWith('@byok-sdk/')
        ? spec === 'workspace:*' && declarations.some(other => other.name === name)
        : declarations.some(other => DEPENDENCY_FIELDS.some(key => other[key]?.[name] === spec)) || additions?.[field]?.[name] === spec;
      if (!valid) throw new Error(`New workspace must reuse a base dependency spec (${name})`);
    }
  }
}

/** Parse only a stable registry version, optionally prefixed by ^ or ~. */
function stableRegistryFloor(spec) {
  if (typeof spec !== 'string') return undefined;
  const match = /^[~^]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(spec);
  // `$` also matches before a final newline; dependency specs must match in full.
  return match?.[0] === spec ? match.slice(1).map(BigInt) : undefined;
}

/**
 * Supply-chain gate for an already published K8 workspace. Same-field package
 * names must stay fixed so an update cannot add, remove or rename a dependency;
 * workspace edges stay byte-identical so it cannot redirect local authority.
 * Both old and new external specs must be single stable registry ranges (^X.Y.Z,
 * ~X.Y.Z or X.Y.Z): this excludes source/alias switches, prereleases, tags,
 * whitespace and composite ranges that could hide a different package or floor.
 * Compare numeric version components, ignoring ^/~, to prevent lowering the
 * CI_BASE floor and re-admitting versions an earlier dependency update excluded.
 * Unchanged specs (including existing abbreviated ranges) remain unchanged;
 * first publication still uses the original base-declaration admission below.
 */
function verifyK8DependencyUpdates(before, after) {
  // #2420 promotes the existing workspace dependency for SQLite snapshot reads.
  if (plain(before.dependencies) && !Object.hasOwn(before.dependencies, K8_CORE)
    && before.devDependencies?.[K8_CORE] === K8_RUNTIME[K8_CORE]
    && after.dependencies[K8_CORE] === K8_RUNTIME[K8_CORE]
    && plain(after.devDependencies) && !Object.hasOwn(after.devDependencies, K8_CORE)) {
    const { [K8_CORE]: core, ...devDependencies } = before.devDependencies;
    before = { ...before, dependencies: { ...before.dependencies, [K8_CORE]: core }, devDependencies };
  }
  for (const field of [...DEPENDENCY_FIELDS, 'peerDependencies']) {
    const previousNames = Object.keys(before[field] ?? {}).filter(name => !(field === 'peerDependencies' && name === 'vitest' && !Object.hasOwn(after[field] ?? {}, name))).sort();
    if (!plain(before[field]) || !plain(after[field])
      || !isDeepStrictEqual(previousNames, Object.keys(after[field]).sort())) {
      throw new Error(`Reviewed CI mapping required: K8 ${field} dependency names must not change`);
    }
    for (const [name, spec] of Object.entries(after[field])) {
      const previous = before[field][name];
      if (previous === spec) continue;
      if (name.startsWith('@byok-sdk/')) throw new Error(`Reviewed CI mapping required: K8 workspace dependency must not change (${name})`);
      const oldFloor = stableRegistryFloor(previous), newFloor = stableRegistryFloor(spec);
      const difference = newFloor && oldFloor ? newFloor.findIndex((part, index) => part !== oldFloor[index]) : -1;
      if (!oldFloor || !newFloor || (difference !== -1 && newFloor[difference] < oldFloor[difference])) {
        throw new Error(`Reviewed CI mapping required: K8 ${field}.${name} must retain a stable registry range with a nondecreasing floor`);
      }
    }
  }
}

/** #1845: the whole K8 manifest against its reviewed shape (see K8 above). */
function verifyK8Manifest(manifest, { base, cwd, workspaceGraph, before }) {
  const refuse = reason => { throw new Error(`Reviewed CI mapping required: the K8 manifest ${reason}`); };
  if (!plain(manifest) || Object.keys(manifest).some(key => !K8_FIELDS.has(key))) refuse('has an unreviewed field');
  if (manifest.name !== K8.name || manifest.type !== 'module' || !version(manifest.version) || typeof manifest.description !== 'string'
    || manifest.main !== K8_EXPORTS['.'].import || manifest.module !== K8_EXPORTS['.'].import || manifest.types !== K8_EXPORTS['.'].types
    || manifest.sideEffects !== false || Object.entries(K8_PUBLISHED).some(([key, value]) => !isDeepStrictEqual(manifest[key], value))
    || !isDeepStrictEqual(manifest.exports, K8_EXPORTS) || !isDeepStrictEqual(manifest.scripts, K8_SCRIPTS)) {
    refuse('has an unreviewed shape');
  }
  if (!isDeepStrictEqual(manifest.dependencies, K8_RUNTIME)) refuse('runtime dependencies must be exactly client, core, protocol and server');
  const peers = manifest.peerDependencies, meta = manifest.peerDependenciesMeta;
  if (!plain(peers) || !isDeepStrictEqual(Object.keys(peers).sort(), K8_OPTIONAL_PEERS)
    || !isDeepStrictEqual(meta, Object.fromEntries(K8_OPTIONAL_PEERS.map(name => [name, { optional: true }])))
    || K8_OPTIONAL_PEERS.some(name => peers[name] !== manifest.devDependencies?.[name])) {
    refuse('peers must be the optional testing peers at the tested devDependency specs');
  }
  if (before?.name === K8.name && before.private !== true) verifyK8DependencyUpdates(before, manifest);
  else verifyDeclaredSpecs(manifest, ['devDependencies'], { base, cwd });
  const edges = [...new Set(DEPENDENCY_FIELDS.flatMap(field => Object.keys(manifest[field] ?? {}).filter(name => name.startsWith('@byok-sdk/'))))].sort();
  if (!isDeepStrictEqual(edges, [...(workspaceGraph?.[K8.dir]?.dependencies ?? [])].sort())) refuse('edges differ from the reviewed graph');
  return manifest;
}

/**
 * #1805: an existing graph-registered private example may change its scripts
 * and dependencies, and nothing else, when the whole new manifest passes the
 * registered-workspace check: edges equal the reviewed graph, and every script
 * and external spec is a base declaration or an exact registered addition.
 * The final comparison still refuses any other field.
 */
function admitRegisteredPrivateManifest(before, after, path, context) {
  const dir = path.slice(0, -'/package.json'.length);
  if (!/^examples\/[^/]+\/package\.json$/.test(path) || !context.workspaceGraph?.[dir]
    || PRIVATE_HOSTED.some(example => example.dir === dir) || before.private !== true) return [];
  const fields = ['scripts', ...DEPENDENCY_FIELDS];
  if (fields.every(field => isDeepStrictEqual(before[field], after[field]))) return [];
  const rest = manifest => Object.fromEntries(Object.entries(manifest).filter(([key]) => !fields.includes(key)));
  if (!isDeepStrictEqual(rest(before), rest(after))) return [];
  try {
    verifyRegisteredPrivateManifest(JSON.parse(readFileSync(resolve(context.cwd, path), 'utf8')), dir, context);
  } catch (error) {
    throw new Error(`Reviewed CI mapping required: ${path} changes more than the reviewed fields (${error.message})`);
  }
  for (const field of fields) {
    if (before[field] === undefined) delete after[field];
    else after[field] = before[field];
  }
  return [dir];
}

/** Returns the admitted workspace records too: their dependencies declare the lock rows they add. */
function admitRegisteredPrivateLock(before, after, context) {
  const added = [], records = [];
  for (const dir of Object.keys(after.workspaces ?? {})) {
    if (Object.hasOwn(before.workspaces ?? {}, dir)) continue;
    const manifest = verifyRegisteredPrivateManifest(JSON.parse(readFileSync(resolve(context.cwd, dir, 'package.json'), 'utf8')), dir, context);
    const expected = { name: manifest.name, version: manifest.version };
    for (const field of DEPENDENCY_FIELDS) if (manifest[field] !== undefined) expected[field] = manifest[field];
    if (!isDeepStrictEqual(after.workspaces[dir], expected)
      || !isDeepStrictEqual(after.packages?.[manifest.name], [`${manifest.name}@workspace:${dir}`])
      || before.packages?.[manifest.name] !== undefined) throw new Error('New workspace lock rows differ from its manifest');
    records.push(after.workspaces[dir]);
    delete after.workspaces[dir]; delete after.packages[manifest.name];
    added.push(dir);
  }
  return { added, records };
}

/** Returns qualifying workspaces and any verified lock-format full-matrix reason. */
export function verifyReviewedContent(path, { base, cwd = process.cwd(), workspaceGraph } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('Content-sensitive impact requires exact CI_BASE');
  const hosted = PRIVATE_HOSTED.find(example => path === `${example.dir}/package.json`);
  const existed = execFileSync('git', ['ls-tree', '--name-only', base, '--', path], { cwd, encoding: 'utf8' }).trim() !== '';
  if (hosted && !existed) {
    // A new file has no base content, so the reviewed shape is the whole check.
    verifyHostedManifest(JSON.parse(readFileSync(resolve(cwd, path), 'utf8')), cwd, hosted);
    return { dirs: [] };
  }
  if (path === `${K8.dir}/package.json`) {
    const before = existed ? JSON.parse(execFileSync('git', ['show', `${base}:${path}`], { cwd, encoding: 'utf8' })) : undefined;
    let after;
    try {
      after = JSON.parse(readFileSync(resolve(cwd, path), 'utf8'));
    } catch (error) {
      throw new Error(`Reviewed CI mapping required: could not read ${path}`, { cause: error });
    }
    if (before?.name === K8.name && before.private !== true) {
      admitPrivateDistImports(before, after);
      if (!isDeepStrictEqual(before.imports, after.imports)) {
        throw new Error('Reviewed CI mapping required: the K8 manifest has unreviewed imports');
      }
      delete after.imports;
    }
    verifyK8Manifest(after, { base, cwd, workspaceGraph, before });
    return { dirs: [K8.dir] };
  }
  if (!existed && /^examples\/[^/]+\/package\.json$/.test(path)) {
    const dir = path.slice(0, -'/package.json'.length);
    verifyRegisteredPrivateManifest(JSON.parse(readFileSync(resolve(cwd, path), 'utf8')), dir, { base, cwd, workspaceGraph });
    return { dirs: [dir] };
  }
  const beforeText = execFileSync('git', ['show', `${base}:${path}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const afterText = readFileSync(resolve(cwd, path), 'utf8');
  if (path === '.gitattributes') {
    throw new Error('Reviewed CI mapping required: .gitattributes changes need a new reviewed mapping');
  }
  if (path === '.node-version') {
    // #702: every CI and release setup-node step reads this pin. Admit only one
    // exact X.Y.Z line: no range, alias, prefix, prerelease or second line.
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\n?$/.test(afterText)) {
      throw new Error('Reviewed CI mapping required: .node-version must hold one exact X.Y.Z version');
    }
    return { dirs: [] };
  }
  const parse = path === 'bun.lock' ? parseBunLock : JSON.parse;
  const qualify = [];
  const before = parse(beforeText), after = parse(afterText);
  if (path.startsWith('examples/') && (before.private !== true || after.private !== true)) throw new Error('Example workspaces must stay private');
  if (path === 'packages/protocol/package.json') {
    // Check the baseline pin before generic dependency updates can normalize it.
    const alias = 'byok-protocol-v8-baseline';
    const tarball = 'https://registry.npmjs.org/@byok-sdk/protocol/-/protocol-0.45.0.tgz';
    const previous = before.devDependencies?.[alias];
    const current = after.devDependencies?.[alias];
    if (previous !== current) {
      if (previous !== undefined || current !== tarball) {
        throw new Error('Reviewed CI mapping required: #2443 admits only the exact published v8 decoder pin');
      }
      delete after.devDependencies[alias];
      qualify.push('packages/protocol');
    }
  }
  if (path !== 'bun.lock') qualify.push(...normalizeDependencyVersions(before, after, path, cwd));
  if (path === 'bun.lock') {
    // Newly introduced hosted workspaces retain their shape/ownership gate.
    for (const example of PRIVATE_HOSTED) {
      if (!before.workspaces?.[example.dir] && after.workspaces?.[example.dir]) admitHostedLock(before, after, cwd, example);
    }
    const { added, records } = admitRegisteredPrivateLock(before, after, { base, cwd, workspaceGraph });
    const impact = dependencyLockImpact(before, after, { cwd, admitted: records });
    return { ...impact, dirs: [...new Set([...added, ...impact.dirs])] };
  } else if (path === 'examples/byok-mcp-server/package.json') {
    if (before.private !== true || after.private !== true) throw new Error('The MCP server example must stay private');
  } else if (path === 'examples/packaging/package.json') {
    if (before.private !== true || after.private !== true) throw new Error('The packaging example must stay private');
  } else if (path === 'examples/host-execution-core/package.json') {
    if (before.private !== true || after.private !== true) throw new Error('The host execution core example must stay private');
  } else if (path === 'package.json') {
    if (before.packageManager !== after.packageManager) {
      // #2347: every setup-bun step and the pinned Bun archive checksums follow
      // this pin. As with .node-version (#702), admit only one exact bun@X.Y.Z
      // replacing another, with every other byte of the manifest unchanged.
      const pin = /^bun@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
      const from = JSON.stringify(before.packageManager), to = JSON.stringify(after.packageManager);
      const exact = value => typeof value === 'string' && pin.test(value);
      if (!exact(before.packageManager) || !exact(after.packageManager)
        || beforeText.split(from).length !== 2 || beforeText.replace(from, to) !== afterText) {
        throw new Error('Reviewed CI mapping required: package.json may change only packageManager, from one exact bun@X.Y.Z to another');
      }
      return { dirs: [], toolchain: true };
    }
    // Reserve the CI helper before generic script normalization can erase it.
    // Only this exact composition may wrap the existing ordered test list.
    const ciHelper = 'test:scripts:ci';
    const ciCommand = 'node --test scripts/ci/*.test.mjs';
    const ciPrefix = 'bun run test:scripts:ci && ';
    if (before.scripts?.[ciHelper] !== undefined || after.scripts?.[ciHelper] !== undefined
      || after.scripts?.['test:scripts']?.startsWith(ciPrefix)) {
      if (after.scripts?.[ciHelper] !== ciCommand || !after.scripts?.['test:scripts']?.startsWith(ciPrefix)) {
        throw new Error('Unreviewed CI test composition');
      }
      if (before.scripts?.[ciHelper] !== undefined) {
        if (before.scripts[ciHelper] !== ciCommand || !before.scripts['test:scripts']?.startsWith(ciPrefix)) {
          throw new Error('Unreviewed CI test composition');
        }
        before.scripts['test:scripts'] = before.scripts['test:scripts'].slice(ciPrefix.length);
        delete before.scripts[ciHelper];
      }
      after.scripts['test:scripts'] = after.scripts['test:scripts'].slice(ciPrefix.length);
      delete after.scripts[ciHelper];
    }
    // Admit rh script changes when both values invoke rh; every other
    // script and field stays in the deep comparison below.
    const harnessScript = value => typeof value === 'string' && value.startsWith('rh ');
    for (const name of new Set([...Object.keys(before.scripts ?? {}), ...Object.keys(after.scripts ?? {})])) {
      const oldValue = before.scripts?.[name], newValue = after.scripts?.[name];
      if ((oldValue === undefined || harnessScript(oldValue)) && (newValue === undefined || harnessScript(newValue))) {
        delete before.scripts?.[name]; delete after.scripts?.[name];
      }
    }
    const documentationTests = admitDocumentationScripts(before, after, cwd);
    const oldCommand = before.scripts?.['test:scripts'], newCommand = after.scripts?.['test:scripts'];
    const prefix = 'node --test --test-concurrency=1 ';
    if (!oldCommand?.startsWith(prefix) || !newCommand?.startsWith(prefix)) throw new Error('Unreviewed test command');
    const oldTests = oldCommand.slice(prefix.length).split(' '), newTests = newCommand.slice(prefix.length).split(' ');
    let index = 0;
    for (const test of newTests) {
      if (test === oldTests[index]) { index++; continue; }
      if (!(/^scripts\/ci\/[a-z0-9-]+\.test\.mjs$/.test(test) || documentationTests.has(test))
        || oldTests.includes(test) || !existsSync(resolve(cwd, test))) throw new Error('Only existing CI contract tests may be added');
    }
    if (index !== oldTests.length || new Set(newTests).size !== newTests.length) throw new Error('Existing tests must remain in order without duplicates');
    delete before.scripts['test:scripts']; delete after.scripts['test:scripts'];
  } else {
    if (!version(before.version) || !version(after.version)) throw new Error('Invalid package version');
    delete before.version; delete after.version;
    // #2533: admit the exact public Node floor raise. Remove this once the
    // release containing it is the comparison base.
    if (publicManifests.includes(path)
      && before.engines?.node === '>=24.22.1'
      && after.engines?.node === '>=24.22.3') {
      after.engines.node = before.engines.node;
    }
    if (publicManifests.includes(path) && admitPrivateDistImports(before, after)) {
      qualify.push(path.slice(0, -'/package.json'.length));
    }
    // #2396: admit this new client bin until the release containing it becomes the base.
    if (path === 'packages/client/package.json' && !Object.hasOwn(before.bin ?? {}, 'byok-mcp-hub')
      && after.bin?.['byok-mcp-hub'] === './dist/bin/byok-mcp-hub.js') {
      delete after.bin['byok-mcp-hub'];
      if (before.bin === undefined && Object.keys(after.bin).length === 0) delete after.bin;
      qualify.push('packages/client');
    }
    // #2286: core gains exactly its sqlite-node entry, from none or from part A's node-only shape. One-time: remove
    // this admission in the release that ships #2286, once that release's core manifest is the base (as #2218 did).
    const sqliteNode = { types: './dist/sqlite-node.d.ts', default: './dist/sqlite-node.js' };
    const partA = { types: './dist/sqlite-node.d.ts', node: { import: './dist/sqlite-node.js' } };
    const prior = before.exports?.['./sqlite-node'];
    if (path === 'packages/core/package.json' && (prior === undefined || isDeepStrictEqual(prior, partA))
      && isDeepStrictEqual(after.exports?.['./sqlite-node'], sqliteNode)) {
      if (prior === undefined) delete after.exports['./sqlite-node']; else after.exports['./sqlite-node'] = prior;
    }
    // #2419: admit this core entry until the release containing it becomes the base.
    const providerModel = { types: './dist/provider-model.d.ts', import: './dist/provider-model.js' };
    if (path === 'packages/core/package.json' && !Object.hasOwn(before.exports ?? {}, './provider-model')
      && isDeepStrictEqual(after.exports?.['./provider-model'], providerModel)) {
      delete after.exports['./provider-model'];
      qualify.push('packages/core');
    }
  }
  // After every dedicated admission, so an edge a branch above already reviewed is not taken here.
  qualify.push(...admitRegisteredPrivateManifest(before, after, path, { base, cwd, workspaceGraph }));
  if (!isDeepStrictEqual(before, after)) throw new Error(`Reviewed CI mapping required: ${path} changes more than the reviewed fields`);
  return { dirs: qualify };
}

/** A `bin:<name>` entry belongs to the one workspace package whose manifest declares that bin. */
function binOwner(name, cwd) {
  const owners = readdirSync(resolve(cwd, 'packages')).filter(dir => {
    const manifest = resolve(cwd, 'packages', dir, 'package.json');
    return existsSync(manifest) && Object.hasOwn(JSON.parse(readFileSync(manifest, 'utf8')).bin ?? {}, name);
  });
  if (owners.length !== 1) throw new Error(`Reviewed CI mapping required: unmapped API entry bin:${name}`);
  return `packages/${owners[0]}`;
}

export function changedApiOwners({ base, cwd = process.cwd() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('API impact requires exact CI_BASE');
  const before = JSON.parse(execFileSync('git', ['show', `${base}:api-surface/entries.json`], { cwd, encoding: 'utf8' }));
  const after = JSON.parse(readFileSync(resolve(cwd, 'api-surface/entries.json'), 'utf8'));
  const owners = new Set();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    const bin = /^bin:([a-z0-9-]+)$/.exec(key);
    if (bin) { owners.add(binOwner(bin[1], cwd)); continue; }
    const match = /^@byok-sdk\/([a-z-]+)(?:[/#]|$)/.exec(key);
    if (!match) throw new Error(`Reviewed CI mapping required: unmapped API entry ${key}`);
    owners.add(`packages/${match[1]}`);
  }
  return [...owners];
}

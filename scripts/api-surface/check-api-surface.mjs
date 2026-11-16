#!/usr/bin/env node
// Public API surface golden gate.
//
// For every publishable package this resolves the names each
// `package.json` `exports` entry exports (the same entry authority as
// `api-surface/entries.json`) against that package's own `dist/` declarations,
// keeps those declarations plus every declaration their signatures reach, and
// compares the rendering byte-for-byte with `api-surface/<pkg>.d.ts`. A public
// type surface therefore cannot change without the golden changing in the same
// commit, which is the point: undeliberate change is what this gate exists to
// make visible. Declarations in a reached file that no exported signature
// reaches are not part of the surface and are left out.
//
// Usage:
//   node scripts/api-surface/check-api-surface.mjs [--update] [--package <name>] [--root <dir>]

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { declarationGraph } from '../release/upgrade-manifest/dts-surface.mjs';
import { checkEntryClosure, manifestEntries } from './entry-closure.mjs';

const PACKAGES = [
  'bot-collaboration',
  'client',
  'cloud',
  'cloud-dataplane',
  'core',
  'protocol',
  'server',
  'ui-runtime',
  'keys',
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..', '..');

// Static `import ... from './x'` / `export ... from './x'` specifiers, plus
// bare side-effect `import './x'`. tsc-emitted declarations only ever carry
// relative or bare specifiers, so nothing else has to resolve.
const FROM_SPECIFIER = /(?:^|[^\w$.])(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /(?:^|[^\w$.])import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /(?:^|[^\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function parseArgs(argv) {
  const options = { update: false, package: null, root: defaultRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--update') {
      options.update = true;
    } else if (arg === '--package') {
      options.package = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--package=')) {
      options.package = arg.slice('--package='.length);
    } else if (arg === '--root') {
      options.root = path.resolve(argv[index + 1] ?? '');
      index += 1;
    } else if (arg.startsWith('--root=')) {
      options.root = path.resolve(arg.slice('--root='.length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.package !== null && !PACKAGES.includes(options.package)) {
    throw new Error(`unknown package: ${options.package} (known: ${PACKAGES.join(', ')})`);
  }
  return options;
}

const toPosix = (value) => value.split(path.sep).join('/');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// `./x.js` -> `./x.d.ts`; `./x` -> `./x.d.ts` or `./x/index.d.ts`.
function resolveDeclaration(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [];
  const suffixes = [
    ['.js', '.d.ts'],
    ['.mjs', '.d.mts'],
    ['.cjs', '.d.cts'],
  ];
  if (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts')) {
    candidates.push(base);
  }
  for (const [from, to] of suffixes) {
    if (base.endsWith(from)) candidates.push(base.slice(0, -from.length) + to);
  }
  candidates.push(`${base}.d.ts`, `${base}.d.mts`, `${base}.d.cts`);
  candidates.push(path.join(base, 'index.d.ts'), path.join(base, 'index.d.mts'));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function collectSpecifiers(source) {
  const statik = new Set();
  const dynamic = new Set();
  for (const pattern of [FROM_SPECIFIER, SIDE_EFFECT_IMPORT]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) statik.add(match[1]);
  }
  DYNAMIC_IMPORT.lastIndex = 0;
  let match;
  while ((match = DYNAMIC_IMPORT.exec(source)) !== null) dynamic.add(match[1]);
  return { statik, dynamic };
}

function normalise(source) {
  return source
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//# sourceMappingURL'))
    .join('\n')
    .replace(/\n+$/, '');
}

// Type entries of one package, keyed by entry id (`@byok-sdk/x/sub`), from the
// same manifest reading that produces `api-surface/entries.json`.
function typeEntries(root, packageDir) {
  const entries = new Map();
  for (const entry of manifestEntries(root)) {
    if (entry.kind !== 'exports' || entry.pkg.directory !== packageDir || entry.types.length === 0) continue;
    if (entry.types.length > 1) throw new Error(`${entry.id}: more than one types file`);
    entries.set(entry.id, path.resolve(root, entry.types[0]));
  }
  return entries;
}

// Reads every declaration file reachable from the entries by static or
// dynamic relative specifier. Throws on an unresolvable relative dynamic
// import, and on any relative specifier that resolves outside the package's own
// dist/, rather than skipping it: a surface we cannot see is not a surface we
// can gate.
function readDeclarations(root, pkg, packageDir, distDir, entryPaths) {
  const queue = [];
  for (const [id, resolved] of entryPaths) {
    if (!existsSync(resolved)) {
      throw new Error(
        `packages/${pkg}/package.json: ${id} types ${toPosix(path.relative(packageDir, resolved))} does not exist — run \`bun run build\``,
      );
    }
    queue.push({ file: resolved, from: null, specifier: toPosix(path.relative(packageDir, resolved)) });
  }
  const files = new Map();
  const distPrefix = distDir + path.sep;
  while (queue.length > 0) {
    const { file, from, specifier: viaSpecifier } = queue.shift();
    const relative = toPosix(path.relative(packageDir, file));
    if (files.has(relative)) continue;
    // The boundary of this package's own dist/ is a hard edge, not a filter:
    // a specifier that escapes it points at a surface this gate cannot see,
    // so refuse rather than silently drop it.
    if (!file.startsWith(distPrefix)) {
      const origin =
        from === null
          ? `packages/${pkg}/package.json`
          : toPosix(path.relative(root, from));
      throw new Error(
        `${origin}: ${JSON.stringify(viaSpecifier)} resolves to ${toPosix(path.relative(root, file))}, outside packages/${pkg}/dist — the public surface cannot be determined`,
      );
    }
    const source = normalise(readFileSync(file, 'utf8'));
    files.set(relative, source);
    const { statik, dynamic } = collectSpecifiers(source);
    for (const specifier of statik) {
      if (!specifier.startsWith('.')) continue; // bare specifier: not our surface
      const resolved = resolveDeclaration(file, specifier);
      if (resolved !== null) queue.push({ file: resolved, from: file, specifier });
    }
    for (const specifier of dynamic) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveDeclaration(file, specifier);
      if (resolved === null) {
        throw new Error(
          `${toPosix(path.relative(root, file))}: unresolvable relative dynamic import ${JSON.stringify(specifier)} — the public surface cannot be determined`,
        );
      }
      queue.push({ file: resolved, from: file, specifier });
    }
  }
  return files;
}

const statementText = (text) =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .join('\n');

// One statement of a reached file, reduced to the names the resolution used,
// or null when it contributes nothing.
function renderStatement(statement, file, routes, kept, exposed) {
  const used = (mark) => routes.has(mark);
  switch (statement.kind) {
    case 'declaration': {
      const key = `${file}#${statement.name}`;
      if (!kept.has(key)) return null;
      return `${exposed.has(key) ? '' : '// support\n'}${statementText(statement.text)}`;
    }
    case 'import': {
      const named = statement.named.filter((item) => used(`import:${item.local}`));
      const defaultLocal = statement.defaultLocal !== null && used(`import:${statement.defaultLocal}`) ? statement.defaultLocal : null;
      const namespace = statement.namespace !== null && used(`import:${statement.namespace}`) ? statement.namespace : null;
      if (named.length === 0 && defaultLocal === null && namespace === null) return null;
      if (named.length === statement.named.length && defaultLocal === statement.defaultLocal && namespace === statement.namespace) {
        return statementText(statement.text);
      }
      const clause = namespace !== null
        ? `* as ${namespace}`
        : [defaultLocal, named.length > 0 ? `{ ${named.map((item) => item.text).join(', ')} }` : null].filter(Boolean).join(', ');
      const quote = statement.quote;
      return `import ${statement.typeOnly}${clause} from ${quote}${statement.specifier}${quote};`;
    }
    case 'export-list': {
      const named = statement.named.filter((item) => used(`export:${item.local}`));
      if (named.length === 0) return null;
      if (named.length === statement.named.length) return statementText(statement.text);
      const from = statement.from === null ? '' : ` from ${statement.from}`;
      return `export ${statement.typeOnly}{ ${named.map((item) => item.text).join(', ')} }${from};`;
    }
    case 'star':
      return used(`star:${statement.specifier}`) ? statementText(statement.text) : null;
    case 'star-as':
    case 'export-default':
      return used(`export:${statement.name}`) ? statementText(statement.text) : null;
    default:
      // A side-effect import or global augmentation changes consumers without
      // exporting a name; refuse it until the golden has a rule for it.
      throw new Error(`${file}: ${statement.kind} statement is not supported by the public surface golden`);
  }
}

// Renders the golden text: an index of every entry's exported names, then each
// declaration file reduced to the declarations those names reach and the
// imports and re-exports that connect them.
export function buildSurface(root, pkg) {
  const packageDir = path.join(root, 'packages', pkg);
  const manifestPath = path.join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`${toPosix(path.relative(root, manifestPath))}: package manifest not found`);
  }
  const distDir = path.join(packageDir, 'dist');
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    throw new Error(
      `packages/${pkg}/dist is missing — run \`bun run build\` before checking the API surface`,
    );
  }
  const entryPaths = typeEntries(root, packageDir);
  if (entryPaths.size === 0) {
    throw new Error(`packages/${pkg}/package.json: no exports entry with a types condition`);
  }
  const files = readDeclarations(root, pkg, packageDir, distDir, entryPaths);
  const entryFiles = new Map([...entryPaths].map(([id, file]) => [id, toPosix(path.relative(packageDir, file))]));
  const graph = declarationGraph({ files, entryFiles });

  // `kept`: every declaration an exported name reaches. `exposed`: the ones a
  // consumer can import by name, directly or as a member of an exported
  // namespace; the rest are rendered as support.
  const kept = new Set();
  const exposed = new Set();
  const queue = [];
  const visit = (ref, isExposed) => {
    if (ref.kind === 'declaration') {
      if (isExposed) exposed.add(ref.key);
      if (kept.has(ref.key)) return;
      kept.add(ref.key);
      queue.push(ref);
    } else if (ref.kind === 'namespace') {
      const marker = `${isExposed ? 'exposed' : 'support'} namespace ${ref.key}`;
      if (kept.has(marker)) return;
      kept.add(marker);
      for (const member of graph.namespaceMembers(ref.key).values()) visit(member, isExposed);
    }
  };
  for (const exported of graph.entries.values()) for (const ref of exported.values()) visit(ref, true);
  while (queue.length > 0) for (const target of graph.references(queue.shift())) visit(target, false);

  const lines = [
    `// @byok-sdk/${pkg} public API surface, generated by \`bun run check:api-surface -- --update\`.`,
    '// Index: every name each package.json exports entry exports, and where it is declared.',
    '// Sections: each declaration file reduced to the declarations those names reach.',
    '// `// support` marks a declaration no entry exports; it is listed because an exported',
    '// signature reaches it, so changing it still changes the public surface.',
  ];
  for (const [entry, exported] of graph.entries) {
    lines.push(`// entry ${entry}`);
    for (const name of [...exported.keys()].sort()) {
      const ref = exported.get(name);
      const target = ref.kind === 'declaration' ? ref.file : ref.kind === 'namespace' ? `namespace ${ref.key}` : ref.key;
      lines.push(`//   ${name} -> ${target}`);
    }
  }
  for (const file of [...files.keys()].sort()) {
    const routes = graph.routes.get(file) ?? new Set();
    const body = graph
      .module(file)
      .statements.map((statement) => renderStatement(statement, file, routes, kept, exposed))
      .filter((text) => text !== null);
    if (body.length === 0) continue;
    lines.push(`// ==== @byok-sdk/${pkg} ${file} ====`, ...body);
  }
  return `${lines.join('\n')}\n`;
}

// Minimal line diff. Common prefix/suffix are trimmed first, and the remaining
// window is compared with an LCS only while it is small enough to stay cheap;
// past that the drift is reported as a block replacement, which is enough for
// a reviewer to see that the surface moved.
export function unifiedDiff(expected, actual, label) {
  const before = expected.split('\n');
  const after = actual.split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }
  const oldWindow = before.slice(start, before.length - end);
  const newWindow = after.slice(start, after.length - end);
  const lines = [`--- ${label} (golden)`, `+++ ${label} (built)`, `@@ line ${start + 1} @@`];

  const maxCells = 4_000_000;
  if (oldWindow.length * newWindow.length > maxCells) {
    lines.push(`(window too large for a line diff: ${oldWindow.length} golden lines vs ${newWindow.length} built lines)`);
    for (const line of oldWindow.slice(0, 40)) lines.push(`-${line}`);
    for (const line of newWindow.slice(0, 40)) lines.push(`+${line}`);
    return lines.join('\n');
  }

  // Classic LCS table over the trimmed window.
  const rows = oldWindow.length;
  const cols = newWindow.length;
  const table = new Uint32Array((rows + 1) * (cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i * (cols + 1) + j] =
        oldWindow[i] === newWindow[j]
          ? table[(i + 1) * (cols + 1) + (j + 1)] + 1
          : Math.max(table[(i + 1) * (cols + 1) + j], table[i * (cols + 1) + (j + 1)]);
    }
  }
  let i = 0;
  let j = 0;
  const emitted = [];
  while (i < rows && j < cols) {
    if (oldWindow[i] === newWindow[j]) {
      emitted.push(` ${oldWindow[i]}`);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * (cols + 1) + j] >= table[i * (cols + 1) + (j + 1)]) {
      emitted.push(`-${oldWindow[i]}`);
      i += 1;
    } else {
      emitted.push(`+${newWindow[j]}`);
      j += 1;
    }
  }
  while (i < rows) {
    emitted.push(`-${oldWindow[i]}`);
    i += 1;
  }
  while (j < cols) {
    emitted.push(`+${newWindow[j]}`);
    j += 1;
  }
  const cap = 400;
  lines.push(...emitted.slice(0, cap));
  if (emitted.length > cap) lines.push(`... ${emitted.length - cap} more diff lines`);
  return lines.join('\n');
}

// The gated inventory must be the published set: every non-private manifest
// under packages/ (the same rule publish.mjs uses to choose what to publish),
// and no golden may outlive the package it described.
export function inventoryFailures(root) {
  const failures = [];
  const packagesDir = path.join(root, 'packages');
  const published = existsSync(packagesDir)
    ? readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(path.join(packagesDir, entry.name, 'package.json')))
        .filter((entry) => readJson(path.join(packagesDir, entry.name, 'package.json')).private !== true)
        .map((entry) => entry.name)
        .sort()
    : [];
  const gated = [...PACKAGES].sort();
  if (JSON.stringify(published) !== JSON.stringify(gated)) {
    failures.push(
      `inventory: the published (non-private) packages under packages/ are [${published.join(', ')}], but this gate covers [${gated.join(', ')}]`,
    );
  }
  const goldenDir = path.join(root, 'api-surface');
  for (const file of existsSync(goldenDir) ? readdirSync(goldenDir).sort() : []) {
    if (file.endsWith('.d.ts') && !PACKAGES.includes(file.slice(0, -'.d.ts'.length))) {
      failures.push(`inventory: api-surface/${file} is an orphan golden for a package this gate does not cover`);
    }
  }
  return failures;
}

export function run(argv, out = console) {
  const options = parseArgs(argv);
  const targets = options.package === null ? PACKAGES : [options.package];
  const goldenDir = path.join(options.root, 'api-surface');
  const failures = options.package === null ? inventoryFailures(options.root) : [];
  const updated = [];

  for (const pkg of targets) {
    let surface;
    try {
      surface = buildSurface(options.root, pkg);
    } catch (error) {
      failures.push(`${pkg}: ${error.message}`);
      continue;
    }
    const goldenPath = path.join(goldenDir, `${pkg}.d.ts`);
    if (options.update) {
      mkdirSync(goldenDir, { recursive: true });
      const previous = existsSync(goldenPath) ? readFileSync(goldenPath, 'utf8') : null;
      if (previous !== surface) {
        writeFileSync(goldenPath, surface);
        updated.push(pkg);
      }
      continue;
    }
    if (!existsSync(goldenPath)) {
      failures.push(
        `${pkg}: api-surface/${pkg}.d.ts is missing — regenerate with \`bun run check:api-surface -- --update\``,
      );
      continue;
    }
    const golden = readFileSync(goldenPath, 'utf8');
    if (golden !== surface) {
      failures.push(
        `${pkg}: public API surface drifted from api-surface/${pkg}.d.ts\n${unifiedDiff(golden, surface, `api-surface/${pkg}.d.ts`)}`,
      );
    }
  }

  // --package checks one public-surface golden. The full gate also owns
  // cross-package runtime inventory, policies and the generated Host table.
  if (options.package === null) {
    try {
      const result = checkEntryClosure(options.root, { update: options.update && failures.length === 0 });
      failures.push(...result.failures);
      for (const measurement of result.measured) out.log(`entry-closure: ${measurement.id}: ${measurement.rawBytes} raw bytes; ${measurement.normalizedBytes}/${measurement.budgetBytes} normalized bytes/budget`);
    } catch (error) { failures.push(`entry-closure: ${error.message}`); }
  }

  if (options.update && failures.length === 0) {
    if (updated.length === 0) {
      out.log(`api-surface: ${targets.length} golden(s) already up to date`);
    } else {
      out.log(`api-surface: updated ${updated.length} golden(s): ${updated.join(', ')}`);
    }
    return 0;
  }

  if (failures.length > 0) {
    for (const failure of failures) out.error(failure);
    out.error(
      options.update
        ? `\napi-surface: ${failures.length} package(s) could not be read; no golden was regenerated for them.`
        : `\napi-surface: ${failures.length} package(s) failed. A golden diff is a public API diff: review which exported names and reached declarations changed, then run \`bun run check:api-surface -- --update\` and commit the golden.`,
    );
    return 1;
  }
  out.log(`api-surface: ${targets.length} package golden(s) match the public surface of the built declarations`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(`api-surface: ${error.message}`);
    process.exitCode = 1;
  }
}

export { PACKAGES };

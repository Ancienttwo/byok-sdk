#!/usr/bin/env node
// Integration-surface golden gate.
//
// For every publishable package this walks the `.d.ts` closure reachable from
// its `exports[*].types` entries inside that package's own `dist/`, normalises
// the result, and compares it byte-for-byte with `api-surface/<pkg>.d.ts`.
// A public type surface therefore cannot change without the golden changing in
// the same commit, which is the point: undeliberate change is what this gate
// exists to make visible.
//
// Usage:
//   node scripts/api-surface/check-api-surface.mjs [--update] [--package <name>] [--root <dir>]

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PACKAGES = [
  'client',
  'cloud',
  'cloud-dataplane',
  'core',
  'protocol',
  'server',
  'ui-runtime',
  'testkit',
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

function entryTypesFor(manifest) {
  const exportsField = manifest.exports;
  const entries = [];
  if (!exportsField || typeof exportsField !== 'object') return entries;
  for (const [subpath, value] of Object.entries(exportsField)) {
    if (subpath === './package.json') continue;
    if (!value || typeof value !== 'object') continue;
    if (typeof value.types !== 'string') continue;
    entries.push(value.types);
  }
  return entries;
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

// Walks the reachable declaration closure and renders the golden text.
// Throws on an unresolvable relative dynamic import, and on any relative
// specifier that resolves outside the package's own dist/, rather than
// skipping it: a surface we cannot see is not a surface we can gate.
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
  const manifest = readJson(manifestPath);
  const entries = entryTypesFor(manifest);
  if (entries.length === 0) {
    throw new Error(`packages/${pkg}/package.json: no exports[*].types entry to walk`);
  }

  const queue = [];
  for (const entry of entries) {
    const resolved = path.resolve(packageDir, entry);
    if (!existsSync(resolved)) {
      throw new Error(
        `packages/${pkg}/package.json: exports entry ${entry} does not exist — run \`bun run build\``,
      );
    }
    queue.push({ file: resolved, from: null, specifier: entry });
  }

  const seen = new Set();
  const files = [];
  const distPrefix = distDir + path.sep;
  while (queue.length > 0) {
    const { file, from, specifier: viaSpecifier } = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    // The boundary of this package's own dist/ is a hard edge, not a filter:
    // a specifier that escapes it points at a surface this gate cannot see,
    // so refuse rather than silently drop it.
    if (file !== distDir && !file.startsWith(distPrefix)) {
      const origin =
        from === null
          ? `packages/${pkg}/package.json`
          : toPosix(path.relative(root, from));
      throw new Error(
        `${origin}: ${JSON.stringify(viaSpecifier)} resolves to ${toPosix(path.relative(root, file))}, outside packages/${pkg}/dist — the reachable surface cannot be determined`,
      );
    }
    const source = readFileSync(file, 'utf8');
    files.push({ file, source });
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
          `${toPosix(path.relative(root, file))}: unresolvable relative dynamic import ${JSON.stringify(specifier)} — the reachable surface cannot be determined`,
        );
      }
      queue.push({ file: resolved, from: file, specifier });
    }
  }

  const rendered = files
    .map(({ file, source }) => ({
      relative: toPosix(path.relative(packageDir, file)),
      body: normalise(source),
    }))
    .sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));

  const chunks = [];
  for (const { relative, body } of rendered) {
    chunks.push(`// ==== @byok-sdk/${pkg} ${relative} ====`);
    if (body.length > 0) chunks.push(body);
  }
  return `${chunks.join('\n')}\n`;
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

export function run(argv, out = console) {
  const options = parseArgs(argv);
  const targets = options.package === null ? PACKAGES : [options.package];
  const goldenDir = path.join(options.root, 'api-surface');
  const failures = [];
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
        `${pkg}: public type surface drifted from api-surface/${pkg}.d.ts\n${unifiedDiff(golden, surface, `api-surface/${pkg}.d.ts`)}`,
      );
    }
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
        : `\napi-surface: ${failures.length} package(s) failed. Public surface changes must be deliberate: review the diff, then run \`bun run check:api-surface -- --update\` and commit the golden.`,
    );
    return 1;
  }
  out.log(`api-surface: ${targets.length} package golden(s) match the built declarations`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(`api-surface: ${error.message}`);
    process.exitCode = 1;
  }
}

export { PACKAGES };

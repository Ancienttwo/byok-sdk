#!/usr/bin/env node
// One-time codemod (#1828): spell every relative import/export specifier in the
// shipping sources of the published packages with its runtime extension, so
// the per-file declarations tsc emits resolve under NodeNext/Node16 as well as
// Bundler. tsc copies specifiers into `.d.ts` as written.
//
//   node scripts/codemod/relative-js-specifiers.mjs
//
// Idempotent: a branch that predates the codemod reruns it after rebasing.
// `./x` becomes `./x.js` when `x.ts`, `x.tsx` or `x.js` exists, `./x.mjs` when
// only `x.mjs` exists, and `./x/index.js` for a directory import. Test files
// keep their spelling. A relative specifier that resolves to none of these is
// an error, and no file is written until every specifier has resolved.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGES = ['bot-collaboration', 'client', 'cloud', 'cloud-dataplane', 'core', 'keys', 'protocol', 'server', 'ui-runtime'];

// `from '…'` (import/export … from), side-effect `import '…'`, and `import('…')`
// in both value and type positions.
const SPECIFIER = /(\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*)(['"])(\.\.?(?:\/[^'"\n]*)?)\2/gm;
const KEEP = /\.(?:[cm]?js|json|node)$/;

const isTest = rel => /(^|\/)(__tests__|fixtures)\//.test(rel) || /\.(test|spec)\.tsx?$/.test(rel);
const isSource = name => /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts');
const isFile = file => existsSync(file) && statSync(file).isFile();

function rewriteSpecifier(file, specifier) {
  if (KEEP.test(specifier)) return specifier;
  const base = path.resolve(path.dirname(file), specifier);
  if (['.ts', '.tsx', '.js'].some(ext => isFile(base + ext))) return `${specifier}.js`;
  if (isFile(`${base}.mjs`)) return `${specifier}.mjs`;
  if (isFile(path.join(base, 'index.ts')) || isFile(path.join(base, 'index.tsx'))) return `${specifier.replace(/\/$/, '')}/index.js`;
  throw new Error(`${path.relative(ROOT, file)}: cannot resolve relative specifier '${specifier}'`);
}

function* sources(dir, srcRoot) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') yield* sources(file, srcRoot);
    } else if (isSource(entry.name) && !isTest(path.relative(srcRoot, file).split(path.sep).join('/'))) {
      yield file;
    }
  }
}

const edits = [];
let specifiers = 0;
for (const pkg of PACKAGES) {
  const srcRoot = path.join(ROOT, 'packages', pkg, 'src');
  for (const file of sources(srcRoot, srcRoot)) {
    const text = readFileSync(file, 'utf8');
    let count = 0;
    const next = text.replace(SPECIFIER, (match, lead, quote, specifier) => {
      const rewritten = rewriteSpecifier(file, specifier);
      if (rewritten === specifier) return match;
      count++;
      return `${lead}${quote}${rewritten}${quote}`;
    });
    if (count === 0) continue;
    edits.push([file, next]);
    specifiers += count;
  }
}
for (const [file, next] of edits) writeFileSync(file, next);
console.log(`relative-js-specifiers: rewrote ${specifiers} specifiers in ${edits.length} files`);

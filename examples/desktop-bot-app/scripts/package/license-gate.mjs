// The license gate of the packaged app (#1499 3.1): every npm package the app
// ships declares a permissive license. What ships is every package esbuild
// bundled (main, renderer, Host), Electron itself, and every package copied into
// resources/host/ (the Pi asset root). A copied file outside those packages fails
// the gate unless the caller names it as a reviewed file without a package
// manifest; the report lists those as not checked. Chromium's third-party notices
// ship as electron-builder writes them.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// #1499 3.1's list, plus BlueOak-1.0.0 and Unlicense for the packages Pi and electron-updater ship (joint decision on #1916).
// A further permissive OSI-approved id enters by joint decision on the PR that needs it; anything else goes to the owner.
const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'ISC', 'BlueOak-1.0.0', 'Unlicense']);
const OPERATORS = new Set(['AND', 'OR', 'WITH', ')']);

/** Whether an SPDX expression grants a permissive license: `OR` needs one permissive side, `AND` needs both. A malformed expression is not permissive. */
export function permissive(expression) {
  if (typeof expression !== 'string') return false;
  const tokens = expression.replaceAll('(', ' ( ').replaceAll(')', ' ) ').trim().split(/\s+/);
  let at = 0;
  const atom = () => {
    const token = tokens[at++];
    if (token === undefined || OPERATORS.has(token)) throw new SyntaxError(expression);
    if (token !== '(') return PERMISSIVE.has(token);
    const inner = either();
    if (tokens[at++] !== ')') throw new SyntaxError(expression);
    return inner;
  };
  const both = () => { let value = atom(); while (tokens[at] === 'AND') { at++; value = atom() && value; } return value; };
  const either = () => { let value = both(); while (tokens[at] === 'OR') { at++; value = both() || value; } return value; };
  try {
    const value = either();
    return at === tokens.length && value;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

/** The nearest package.json above `file` that names a package (a bare `{ "type": "module" }` marker belongs to its enclosing package). */
function owningPackage(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    const pkg = (() => { try { return readJson(manifest); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } })();
    if (typeof pkg?.name === 'string') return { pkg, dir };
    if (path.dirname(dir) === dir) throw new Error(`No package owns the bundled file ${file}`);
  }
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}

const slashed = file => file.split(path.sep).join('/');

/**
 * The shipped packages, by `name@version`: the owner of each input of the esbuild
 * metafiles (paths relative to `root`, the builds' working directory), each of
 * `manifests`, and each named package.json under `copiedRoots`. Every other file
 * under `copiedRoots` must lie in one of those copied packages or be a key of
 * `unpackaged` (`/`-separated, relative to `root`, mapped to its provenance);
 * an `unpackaged` key wins over the package around it.
 */
export function licenseInventory({ root, metafiles, manifests, copiedRoots, unpackaged }) {
  const inventory = new Map();
  const add = (pkg, where) => inventory.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license: pkg.license, where });
  for (const input of metafiles.flatMap(metafile => Object.keys(metafile.inputs))) {
    // esbuild lists a module that a package's `browser` field maps to false as `(disabled):<path>`; nothing of it ships.
    if (input.startsWith('(disabled):')) continue;
    const { pkg, dir } = owningPackage(path.resolve(root, input));
    add(pkg, slashed(path.relative(root, dir)) || '.');
  }
  for (const manifest of manifests) add(readJson(manifest), slashed(path.relative(root, path.dirname(manifest))));
  const reviewed = [];
  for (const copied of copiedRoots) {
    const copiedFiles = files(copied).map(file => slashed(path.relative(root, file)));
    const packageDirs = copiedFiles.filter(file => file.endsWith('/package.json')).flatMap(file => {
      const pkg = readJson(path.join(root, file));
      if (typeof pkg.name !== 'string') return [];
      add(pkg, path.posix.dirname(file));
      return [`${path.posix.dirname(file)}/`];
    });
    for (const file of copiedFiles) {
      if (Object.hasOwn(unpackaged, file)) reviewed.push({ file, provenance: unpackaged[file] });
      else if (!packageDirs.some(dir => file.startsWith(dir))) throw new Error(`License gate: ${file} ships in no package and is not a reviewed file`);
    }
  }
  return { packages: [...inventory.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version))), reviewed };
}

/** The inventory as Markdown, and the packages whose declared license is not permissive. */
export function licenseReport({ packages, reviewed }) {
  const refused = packages.filter(entry => !permissive(entry.license));
  const table = ['| Package | Version | License | Shipped from |', '| --- | --- | --- | --- |',
    ...packages.map(entry => `| ${entry.name} | ${entry.version} | ${JSON.stringify(entry.license ?? null)}${refused.includes(entry) ? ' **refused**' : ''} | ${entry.where} |`),
    '', 'Shipped without a package manifest, not checked by the gate:', '', '| File | Provenance |', '| --- | --- |',
    ...reviewed.map(entry => `| ${entry.file} | ${entry.provenance} |`)].join('\n');
  return { table, refused };
}

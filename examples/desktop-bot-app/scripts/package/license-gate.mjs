// The license gate of the packaged app (#1499 3.1): every npm package the app
// ships declares a permissive license. What ships is every package esbuild
// bundled (main, renderer, Host) and every package copied into resources/host/
// (the Pi asset root). Electron's own LICENSE and Chromium's notices ship as
// electron-builder writes them.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'ISC']);

/** Whether an SPDX expression grants a permissive license: `OR` needs one permissive side, `AND` needs both. A malformed expression is not permissive. */
export function permissive(expression) {
  if (typeof expression !== 'string') return false;
  const tokens = expression.replaceAll('(', ' ( ').replaceAll(')', ' ) ').trim().split(/\s+/);
  let at = 0;
  const atom = () => {
    const token = tokens[at++];
    if (token !== '(') return token !== undefined && PERMISSIVE.has(token);
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

function packageFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? packageFiles(path.join(dir, entry.name))
    : entry.name === 'package.json' ? [path.join(dir, entry.name)] : []);
}

/**
 * The shipped packages, by `name@version`: the owner of each input of the esbuild
 * metafiles (paths relative to `root`, the builds' working directory) and each
 * named package.json under `copiedRoots`.
 */
export function licenseInventory({ root, metafiles, copiedRoots }) {
  const inventory = new Map();
  const add = (pkg, where) => inventory.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license: pkg.license, where });
  for (const input of metafiles.flatMap(metafile => Object.keys(metafile.inputs))) {
    // esbuild lists a module that a package's `browser` field maps to false as `(disabled):<path>`; nothing of it ships.
    if (input.startsWith('(disabled):')) continue;
    const { pkg, dir } = owningPackage(path.resolve(root, input));
    add(pkg, path.relative(root, dir) || '.');
  }
  for (const copied of copiedRoots) {
    for (const manifest of packageFiles(copied)) {
      const pkg = readJson(manifest);
      if (typeof pkg.name === 'string') add(pkg, path.relative(root, path.dirname(manifest)));
    }
  }
  return [...inventory.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
}

/** The inventory as a Markdown table, and the packages whose declared license is not permissive. */
export function licenseReport(inventory) {
  const refused = inventory.filter(entry => !permissive(entry.license));
  const table = ['| Package | Version | License | Shipped from |', '| --- | --- | --- | --- |',
    ...inventory.map(entry => `| ${entry.name} | ${entry.version} | ${JSON.stringify(entry.license ?? null)}${refused.includes(entry) ? ' **refused**' : ''} | ${entry.where} |`)].join('\n');
  return { table, refused };
}

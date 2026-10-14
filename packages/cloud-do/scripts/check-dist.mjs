import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { specifiers } from '../../../scripts/api-surface/module-scan.mjs';

const externalTypes = ['@earendil-works/pi-durable', '@earendil-works/pi-ai', '@earendil-works/chord'];

function inside(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function resolveDeclaration(file, specifier, dist) {
  const base = path.resolve(path.dirname(file), specifier);
  if (!inside(dist, base)) throw new Error(`${file}: declaration path leaves dist: ${specifier}`);
  const replaced = base.replace(/\.(?:mjs|cjs|js)$/, extension => ({ '.js': '.d.ts', '.mjs': '.d.mts', '.cjs': '.d.cts' })[extension]);
  const candidates = [replaced, base + '.d.ts', path.join(base, 'index.d.ts')];
  const resolved = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!resolved) throw new Error(`${file}: missing relative declaration: ${specifier}`);
  if (!inside(dist, realpathSync(resolved))) throw new Error(`${file}: declaration path leaves dist: ${specifier}`);
}

export function checkDist(directory) {
  const dist = realpathSync(directory);
  let files = 0;
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.isFile() || (!file.endsWith('.js') && !file.endsWith('.d.ts'))) continue;
      files++;
      if (file.endsWith('.js')) continue; // Runtime policy belongs to check:api-surface.
      for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.')) {
          resolveDeclaration(file, specifier, dist);
        } else if (specifier !== 'cloudflare:workers'
          && !externalTypes.some(name => specifier === name || specifier.startsWith(name + '/'))) {
          throw new Error(`${file}: undeclared external type: ${specifier}`);
        }
      }
    }
  }
  visit(dist);
  if (!files) throw new Error('dist has no JavaScript or declaration files');
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = process.argv[2] ?? fileURLToPath(new URL('../dist', import.meta.url));
    console.log(`[cloud-do-dist] checked ${checkDist(directory)} files`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

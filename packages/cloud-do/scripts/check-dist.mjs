import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizer } from 'acorn';

const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const externalTypes = ['@earendil-works/pi-durable', '@earendil-works/pi-ai', '@earendil-works/chord'];

// Tokens exclude comments and decode escapes. They also accept declaration syntax.
function specifiers(source) {
  const tokens = [...tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module' })];
  const found = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (token.type.label === 'import' || token.value === 'require') {
      if (next?.type.label === 'string') found.add(next.value);
      if (next?.type.label === '(' && tokens[i + 2]?.type.label === 'string') found.add(tokens[i + 2].value);
    }
    if (token.type.label !== 'import' && token.type.label !== 'export') continue;
    if (next?.type.label === '(') continue;
    if (token.type.label === 'export' && !['*', '{'].includes(next?.type.label)
      && !(next?.value === 'type' && ['*', '{'].includes(tokens[i + 2]?.type.label))) continue;
    for (let j = i + 1; j < tokens.length && tokens[j].type.label !== ';'; j++) {
      if (tokens[j].value === 'from' && tokens[j + 1]?.type.label === 'string') {
        found.add(tokens[j + 1].value);
        break;
      }
    }
  }
  return found;
}

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
      for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
        if (file.endsWith('.js')) {
          if (specifier.startsWith('node:') || builtins.has(specifier)) {
            throw new Error(`${file}: Node builtin is not allowed: ${specifier}`);
          }
        } else if (specifier.startsWith('.')) {
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

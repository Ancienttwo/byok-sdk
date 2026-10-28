// Public export digests from the api-surface goldens.
//
// The goldens (`api-surface/<pkg>.d.ts`) are already the gated, checked-in
// image of every package's declaration closure, so this module reads them
// instead of `dist/`: the upgrade-manifest snapshot then needs no build and is
// identical on every machine for the same commit.
//
// For each public entry (`api-surface/entries.json`, kind `exports`) it
// resolves the entry declaration file's exports through `export *`,
// `export { a as b } from`, local `export { a }`, and import bindings, and
// gives every exported name a digest. The digest covers the exported
// declaration text (comments stripped, whitespace collapsed, `export` and
// `declare` modifiers dropped) plus the text of every non-public declaration
// it reaches by identifier, transitively. A declaration that is itself public
// is cut off from the closure: its own item records its change, so one edit
// to a shared type is reported once, where it happened.
//
// The parser understands the statement forms tsc emits into `.d.ts` files and
// throws on anything else, so a new emit shape fails loudly instead of being
// silently skipped.

import { createHash } from 'node:crypto';
import path from 'node:path';

const SECTION = /^\/\/ ==== (\S+) (dist\/\S+) ====$/;
const IDENT = /[A-Za-z_$][\w$]*/g;
const INLINE_IMPORT = /import\(\s*["']([^"']+)["']\s*\)\.([A-Za-z_$][\w$]*)/g;
const BLOCK_HEADS = new Set(['interface', 'class', 'enum', 'namespace', 'module', 'global']);
const DECLARATION = /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(const\s+enum|const|let|var|function|class|interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/;

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Split a concatenated golden into `{ 'dist/x.d.ts': source }`. */
export function splitGolden(text) {
  const files = new Map();
  let current = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = SECTION.exec(line);
    if (match) {
      current = match[2];
      if (files.has(current)) throw new Error(`duplicate golden section ${current}`);
      files.set(current, []);
      continue;
    }
    if (current !== null) files.get(current).push(line);
  }
  return new Map([...files].map(([file, lines]) => [file, lines.join('\n')]));
}

/**
 * Top-level statements with comments removed. A statement ends at a `;` at
 * depth 0, or at the `}` that closes a block declaration (interface, class,
 * enum, namespace, module, global), which tsc emits without a semicolon.
 */
export function splitStatements(source, { raw = false } = {}) {
  const statements = [];
  let current = '';
  let depth = 0;
  const templates = [];
  let index = 0;
  const flush = () => {
    const text = raw ? current.replace(/^\s*\n/, '').trimEnd() : current.replace(/\s+/g, ' ').trim();
    if (text.trim() !== '' && text.trim() !== ';') statements.push(raw ? text : text.replace(/;$/, '').trim());
    current = '';
  };
  const head = () => {
    const words = current.trim().split(/\s+/).filter((word) => !['export', 'declare', 'default', 'abstract', 'const'].includes(word));
    return words[0] ?? '';
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (templates.length > 0 && templates.at(-1) === depth && char === '}') {
      // Close a `${ ... }` inside a template literal and resume the template.
      templates.pop();
      current += char;
      index += 1;
      index = readTemplate(source, index, (chunk, opened) => {
        current += chunk;
        if (opened) templates.push(depth);
      });
      continue;
    }
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) throw new Error('unterminated block comment');
      index = end + 2;
      current += ' ';
      continue;
    }
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < source.length && source[end] !== char) end += source[end] === '\\' ? 2 : 1;
      if (end >= source.length) throw new Error('unterminated string literal');
      current += source.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '`') {
      current += char;
      index = readTemplate(source, index + 1, (chunk, opened) => {
        current += chunk;
        if (opened) templates.push(depth);
      });
      continue;
    }
    if (char === '{' || char === '(' || char === '[') depth += 1;
    if (char === '}' || char === ')' || char === ']') {
      depth -= 1;
      if (depth < 0) throw new Error('unbalanced declaration source');
    }
    current += char;
    index += 1;
    if (depth === 0 && char === ';') flush();
    else if (depth === 0 && char === '}' && BLOCK_HEADS.has(head())) flush();
  }
  if (depth !== 0) throw new Error('unbalanced declaration source');
  flush();
  return statements;
}

// Reads template text from `index` up to the closing backtick or a `${`.
function readTemplate(source, index, emit) {
  let cursor = index;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (char === '`') {
      emit(source.slice(index, cursor + 1), false);
      return cursor + 1;
    }
    if (char === '$' && source[cursor + 1] === '{') {
      emit(source.slice(index, cursor + 2), true);
      return cursor + 2;
    }
    cursor += 1;
  }
  throw new Error('unterminated template literal');
}

function parseSpecifierList(list) {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part);
      if (!match) throw new Error(`unsupported specifier "${part}"`);
      return { imported: match[1], local: match[2] ?? match[1] };
    });
}

/** Parse one declaration file into declarations, imports and export forms. */
export function parseModule(source) {
  const module = { declarations: new Map(), imports: new Map(), exports: [] };
  for (const statement of splitStatements(source)) {
    let match;
    if ((match = /^import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]$/.exec(statement))) {
      const [, clause, specifier] = match;
      const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
      if (namespace) {
        module.imports.set(namespace[1], { specifier, imported: '*' });
        continue;
      }
      const parts = /^(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?$/.exec(clause);
      if (!parts) throw new Error(`unsupported import "${statement}"`);
      if (parts[1]) module.imports.set(parts[1], { specifier, imported: 'default' });
      for (const item of parseSpecifierList(parts[2] ?? '')) module.imports.set(item.local, { specifier, imported: item.imported });
      continue;
    }
    if (/^import\s+['"][^'"]+['"]$/.test(statement)) continue;
    if ((match = /^export\s+\*\s+from\s+['"]([^'"]+)['"]$/.exec(statement))) {
      module.exports.push({ form: 'star', specifier: match[1] });
      continue;
    }
    if ((match = /^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]$/.exec(statement))) {
      module.exports.push({ form: 'star-as', name: match[1], specifier: match[2] });
      continue;
    }
    if ((match = /^export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]$/.exec(statement))) {
      for (const item of parseSpecifierList(match[1])) {
        module.exports.push({ form: 'from', name: item.local, imported: item.imported, specifier: match[2] });
      }
      continue;
    }
    if ((match = /^export\s+(?:type\s+)?\{([^}]*)\}$/.exec(statement))) {
      for (const item of parseSpecifierList(match[1])) module.exports.push({ form: 'local', name: item.local, local: item.imported });
      continue;
    }
    if ((match = /^export\s+default\s+([A-Za-z_$][\w$]*)$/.exec(statement))) {
      module.exports.push({ form: 'local', name: 'default', local: match[1] });
      continue;
    }
    if (/^(?:export\s+)?declare\s+global\b/.test(statement)) {
      addDeclaration(module, 'global', statement);
      continue;
    }
    if ((match = DECLARATION.exec(statement))) {
      const name = match[2];
      addDeclaration(module, name, statement);
      if (/^export\s+default\s/.test(statement)) module.exports.push({ form: 'local', name: 'default', local: name });
      else if (/^export\s/.test(statement)) module.exports.push({ form: 'local', name, local: name });
      continue;
    }
    throw new Error(`unsupported declaration statement: ${statement.slice(0, 120)}`);
  }
  return module;
}

function addDeclaration(module, name, statement) {
  const text = statement.replace(/^export\s+/, '').replace(/^default\s+/, '').replace(/^declare\s+/, '');
  const list = module.declarations.get(name) ?? [];
  list.push(text);
  module.declarations.set(name, list);
}

function resolveRelative(files, fromFile, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const stem = base.replace(/\.(?:d\.ts|js|mjs|cjs)$/, '');
  for (const candidate of [`${stem}.d.ts`, `${stem}/index.d.ts`, `${base}.d.ts`, `${base}/index.d.ts`]) {
    if (files.has(candidate)) return candidate;
  }
  throw new Error(`${fromFile}: cannot resolve "${specifier}" inside the golden`);
}

const isRelative = (specifier) => specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');

/** Export digests for every public entry of one package golden. */
export function packageSurface({ golden, entryFiles }) {
  const files = splitGolden(golden);
  const modules = new Map();
  const moduleOf = (file) => {
    if (!modules.has(file)) {
      if (!files.has(file)) throw new Error(`golden has no section for ${file}`);
      try {
        modules.set(file, parseModule(files.get(file)));
      } catch (error) {
        throw new Error(`${file}: ${error.message}`);
      }
    }
    return modules.get(file);
  };

  const exportCache = new Map();
  const exportsOf = (file) => {
    if (exportCache.has(file)) return exportCache.get(file);
    const resolved = new Map();
    exportCache.set(file, resolved);
    const module = moduleOf(file);
    const stars = [];
    for (const entry of module.exports) {
      if (entry.form === 'local') resolved.set(entry.name, bindingOf(file, entry.local));
      else if (entry.form === 'from') resolved.set(entry.name, importRef(file, entry.specifier, entry.imported));
      else if (entry.form === 'star-as') resolved.set(entry.name, importRef(file, entry.specifier, '*'));
      else stars.push(entry.specifier);
    }
    for (const specifier of stars) {
      if (!isRelative(specifier)) throw new Error(`${file}: export * from bare "${specifier}" cannot be enumerated`);
      for (const [name, ref] of exportsOf(resolveRelative(files, file, specifier))) {
        if (name !== 'default' && !resolved.has(name)) resolved.set(name, ref);
      }
    }
    return resolved;
  };
  const importRef = (file, specifier, imported) => {
    if (!isRelative(specifier)) return { kind: 'bare', key: `${specifier}#${imported}` };
    const target = resolveRelative(files, file, specifier);
    if (imported === '*') return { kind: 'namespace', key: target };
    const ref = exportsOf(target).get(imported);
    if (!ref) throw new Error(`${file}: "${specifier}" does not export ${imported}`);
    return ref;
  };
  const bindingOf = (file, name) => {
    const module = moduleOf(file);
    if (module.declarations.has(name)) return { kind: 'declaration', key: `${file}#${name}`, file, name };
    const imported = module.imports.get(name);
    if (imported) return importRef(file, imported.specifier, imported.imported);
    return null;
  };

  const entries = new Map();
  for (const [entry, file] of entryFiles) entries.set(entry, exportsOf(file));
  const publicKeys = new Set();
  for (const exported of entries.values()) for (const ref of exported.values()) publicKeys.add(ref.key);

  const textOf = (ref) => moduleOf(ref.file).declarations.get(ref.name).join('\n');
  const referencesOf = (ref) => {
    const text = textOf(ref).replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    const found = new Map();
    const raw = textOf(ref);
    for (const match of raw.matchAll(INLINE_IMPORT)) {
      const target = isRelative(match[1]) ? importRef(ref.file, match[1], match[2]) : { kind: 'bare', key: `${match[1]}#${match[2]}` };
      found.set(target.key, target);
    }
    for (const token of new Set(text.match(IDENT) ?? [])) {
      if (token === ref.name) continue;
      const target = bindingOf(ref.file, token);
      if (target) found.set(target.key, target);
    }
    return [...found.values()];
  };
  const digestCache = new Map();
  const digestOf = (ref) => {
    if (digestCache.has(ref.key)) return digestCache.get(ref.key);
    let digest;
    if (ref.kind === 'bare') digest = sha256(`bare ${ref.key}`).slice(0, 16);
    else if (ref.kind === 'namespace') {
      digest = sha256([...exportsOf(ref.key)].map(([name, inner]) => `${name}=${digestOf(inner)}`).sort().join('\n')).slice(0, 16);
    } else {
      // Root text plus the transitive closure of non-public declarations.
      const parts = [`root ${textOf(ref)}`];
      const seen = new Set([ref.key]);
      const queue = [ref];
      while (queue.length > 0) {
        for (const target of referencesOf(queue.shift())) {
          if (seen.has(target.key)) continue;
          seen.add(target.key);
          if (target.kind !== 'declaration' || publicKeys.has(target.key)) continue;
          parts.push(`${target.name} ${textOf(target)}`);
          queue.push(target);
        }
      }
      digest = sha256([parts[0], ...parts.slice(1).sort()].join('\n')).slice(0, 16);
    }
    digestCache.set(ref.key, digest);
    return digest;
  };

  const result = new Map();
  for (const [entry, exported] of entries) {
    result.set(entry, new Map([...exported].map(([name, ref]) => [name, digestOf(ref)])));
  }
  return { entries: result, files };
}

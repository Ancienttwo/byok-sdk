// Public export digests from the api-surface goldens.
//
// The goldens (`api-surface/<pkg>.d.ts`) are already the gated, checked-in
// public surface of every package: the declarations its entries export and
// everything they reach, rendered by check-api-surface.mjs from the same
// `declarationGraph` below. This module reads them instead of `dist/`: the
// upgrade-manifest snapshot then needs no build and is identical on every
// machine for the same commit.
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
const INLINE_MODULE = /import\(\s*["']([^"']+)["']\s*\)(?!\s*\.)/g;
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

// Declaration text with string literal contents and template literal text
// removed. Template `${...}` expressions are code and stay, so a type named
// inside one is still a reference.
function codeOnly(text) {
  let out = '';
  let depth = 0;
  const templates = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1;
      out += '""';
      index = end + 1;
      continue;
    }
    if (char === '`' || (char === '}' && templates.at(-1) === depth)) {
      if (char === '}') templates.pop();
      let end = index + 1;
      while (end < text.length && text[end] !== '`' && !(text[end] === '$' && text[end + 1] === '{')) end += text[end] === '\\' ? 2 : 1;
      out += ' ';
      if (text[end] === '$') {
        templates.push(depth);
        index = end + 2;
      } else index = end + 1;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    out += char;
    index += 1;
  }
  return out;
}

function parseSpecifierList(list) {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part);
      if (!match) throw new Error(`unsupported specifier "${part}"`);
      return { imported: match[1], local: match[2] ?? match[1], text: part };
    });
}

/**
 * Parse one declaration file into declarations, imports and export forms.
 * `statements` keeps every top-level statement in source order with its raw
 * text (comments removed, indentation kept) and the parsed form, so a renderer
 * can print the subset a resolution used.
 */
export function parseModule(source) {
  const module = { declarations: new Map(), imports: new Map(), exports: [], statements: [] };
  const raws = splitStatements(source, { raw: true });
  const statements = splitStatements(source);
  if (raws.length !== statements.length) throw new Error('raw and normalised statements disagree');
  statements.forEach((statement, index) => {
    const record = parseStatement(module, statement);
    module.statements.push({ ...record, text: raws[index] });
  });
  return module;
}

function parseStatement(module, statement) {
  let match;
  if ((match = /^import\s+(type\s+)?(.+?)\s+from\s+(['"])([^'"]+)['"]$/.exec(statement))) {
    const [, typeOnly = '', clause, quote, specifier] = match;
    const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
    if (namespace) {
      module.imports.set(namespace[1], { specifier, imported: '*' });
      return { kind: 'import', typeOnly, quote, specifier, namespace: namespace[1], defaultLocal: null, named: [] };
    }
    const parts = /^(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?$/.exec(clause);
    if (!parts) throw new Error(`unsupported import "${statement}"`);
    if (parts[1]) module.imports.set(parts[1], { specifier, imported: 'default' });
    const named = parseSpecifierList(parts[2] ?? '');
    for (const item of named) module.imports.set(item.local, { specifier, imported: item.imported });
    return { kind: 'import', typeOnly, quote, specifier, namespace: null, defaultLocal: parts[1] ?? null, named };
  }
  if (/^import\s+['"][^'"]+['"]$/.test(statement)) return { kind: 'side-effect' };
  if ((match = /^export\s+\*\s+from\s+['"]([^'"]+)['"]$/.exec(statement))) {
    module.exports.push({ form: 'star', specifier: match[1] });
    return { kind: 'star', specifier: match[1] };
  }
  if ((match = /^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]$/.exec(statement))) {
    module.exports.push({ form: 'star-as', name: match[1], specifier: match[2] });
    return { kind: 'star-as', name: match[1] };
  }
  if ((match = /^export\s+(type\s+)?\{([^}]*)\}\s*from\s*((['"])[^'"]+['"])$/.exec(statement))) {
    const named = parseSpecifierList(match[2]);
    const specifier = match[3].slice(1, -1);
    for (const item of named) module.exports.push({ form: 'from', name: item.local, imported: item.imported, specifier });
    return { kind: 'export-list', typeOnly: match[1] ?? '', from: match[3], named };
  }
  if ((match = /^export\s+(type\s+)?\{([^}]*)\}$/.exec(statement))) {
    const named = parseSpecifierList(match[2]);
    for (const item of named) module.exports.push({ form: 'local', name: item.local, local: item.imported });
    return { kind: 'export-list', typeOnly: match[1] ?? '', from: null, named };
  }
  if ((match = /^export\s+default\s+([A-Za-z_$][\w$]*)$/.exec(statement))) {
    module.exports.push({ form: 'local', name: 'default', local: match[1] });
    return { kind: 'export-default', name: 'default' };
  }
  if (/^(?:export\s+)?declare\s+global\b/.test(statement)) {
    addDeclaration(module, 'global', statement);
    return { kind: 'global' };
  }
  if ((match = DECLARATION.exec(statement))) {
    const name = match[2];
    addDeclaration(module, name, statement);
    if (/^export\s+default\s/.test(statement)) module.exports.push({ form: 'local', name: 'default', local: name });
    else if (/^export\s/.test(statement)) module.exports.push({ form: 'local', name, local: name });
    return { kind: 'declaration', name };
  }
  throw new Error(`unsupported declaration statement: ${statement.slice(0, 120)}`);
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

/**
 * Symbol graph of one package's declaration files (`{ 'dist/x.d.ts': source }`).
 *
 * `entries` maps every public entry to its exported names and what each one
 * resolves to: `{ kind: 'declaration', key, file, name }`, `{ kind: 'namespace',
 * key: file }` or `{ kind: 'bare', key }` for a name re-exported from another
 * package. `references(ref)` lists what a declaration names by identifier or
 * inline `import()`; a whole-module `import('./x')` is a namespace. Every
 * export, star re-export and import binding a resolution passes through is
 * recorded in `routes` (per file: `export:<name>`, `star:<specifier>`,
 * `import:<local>`, and `module` on every file a resolution reads), which is
 * what a renderer needs to print a self-consistent subset of the files.
 */
export function declarationGraph({ files, entryFiles }) {
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
  const routes = new Map();
  const route = (file, mark) => {
    if (!routes.has(file)) routes.set(file, new Set());
    routes.get(file).add(mark);
  };

  // Names a file exports, explicit forms first, then `export *` in order, the
  // first star that provides a name winning (ES module semantics for `.d.ts`).
  const namesCache = new Map();
  const exportNames = (file) => {
    if (namesCache.has(file)) return namesCache.get(file);
    const names = new Set();
    namesCache.set(file, names);
    for (const entry of moduleOf(file).exports) if (entry.form !== 'star') names.add(entry.name);
    for (const entry of moduleOf(file).exports) {
      if (entry.form !== 'star') continue;
      if (!isRelative(entry.specifier)) throw new Error(`${file}: export * from bare "${entry.specifier}" cannot be enumerated`);
      for (const name of exportNames(resolveRelative(files, file, entry.specifier))) if (name !== 'default') names.add(name);
    }
    return names;
  };
  const resolved = new Map();
  const exportOf = (file, name) => {
    const cacheKey = `${file}#${name}`;
    if (resolved.has(cacheKey)) return resolved.get(cacheKey);
    let ref;
    const explicit = moduleOf(file).exports.filter((entry) => entry.form !== 'star' && entry.name === name).at(-1);
    if (explicit) {
      route(file, `export:${name}`);
      if (explicit.form === 'local') {
        ref = bindingOf(file, explicit.local);
        if (!ref) throw new Error(`${file}: exports ${name} but neither declares nor imports ${explicit.local}`);
      }
      else if (explicit.form === 'from') ref = importRef(file, explicit.specifier, explicit.imported);
      else ref = importRef(file, explicit.specifier, '*');
    } else if (name !== 'default') {
      for (const entry of moduleOf(file).exports) {
        if (entry.form !== 'star') continue;
        const target = resolveRelative(files, file, entry.specifier);
        if (!exportNames(target).has(name)) continue;
        route(file, `star:${entry.specifier}`);
        route(target, 'module');
        ref = exportOf(target, name);
        break;
      }
    }
    resolved.set(cacheKey, ref);
    return ref;
  };
  const importRef = (file, specifier, imported) => {
    if (!isRelative(specifier)) return { kind: 'bare', key: `${specifier}#${imported}` };
    const target = resolveRelative(files, file, specifier);
    route(target, 'module');
    if (imported === '*') return { kind: 'namespace', key: target };
    const ref = exportNames(target).has(imported) ? exportOf(target, imported) : undefined;
    if (!ref) throw new Error(`${file}: "${specifier}" does not export ${imported}`);
    return ref;
  };
  const bindingOf = (file, name) => {
    const module = moduleOf(file);
    if (module.declarations.has(name)) return { kind: 'declaration', key: `${file}#${name}`, file, name };
    const imported = module.imports.get(name);
    if (!imported) return null;
    route(file, `import:${name}`);
    return importRef(file, imported.specifier, imported.imported);
  };
  const namespaceMembers = (file) => new Map([...exportNames(file)].map((name) => [name, exportOf(file, name)]));

  const entries = new Map();
  for (const [entry, file] of entryFiles) {
    route(file, 'module');
    entries.set(entry, namespaceMembers(file));
  }
  const publicKeys = new Set();
  for (const exported of entries.values()) for (const ref of exported.values()) publicKeys.add(ref.key);

  const text = (ref) => moduleOf(ref.file).declarations.get(ref.name).join('\n');
  const references = (ref) => {
    const found = new Map();
    const raw = text(ref);
    for (const match of raw.matchAll(INLINE_IMPORT)) {
      const target = isRelative(match[1]) ? importRef(ref.file, match[1], match[2]) : { kind: 'bare', key: `${match[1]}#${match[2]}` };
      found.set(target.key, target);
    }
    // `typeof import('./x')` names the whole module.
    for (const match of raw.matchAll(INLINE_MODULE)) {
      const target = isRelative(match[1]) ? importRef(ref.file, match[1], '*') : { kind: 'bare', key: `${match[1]}#*` };
      found.set(target.key, target);
    }
    const code = codeOnly(raw);
    for (const token of new Set(code.match(IDENT) ?? [])) {
      if (token === ref.name) continue;
      const target = bindingOf(ref.file, token);
      if (!target) continue;
      if (target.kind !== 'namespace') {
        found.set(target.key, target);
        continue;
      }
      // `ns.Member` reaches that member only; a bare `ns` reaches the module.
      for (const use of code.matchAll(new RegExp(`(?<![\\w$])${token.replace(/\$/g, '\\$')}(?:\\s*\\.\\s*([A-Za-z_$][\\w$]*))?(?![\\w$])`, 'g'))) {
        const member = use[1] === undefined ? target : exportNames(target.key).has(use[1]) ? exportOf(target.key, use[1]) : null;
        if (member === null) throw new Error(`${ref.file}: ${token}.${use[1]} is not exported by ${target.key}`);
        found.set(member.key, member);
      }
    }
    return [...found.values()];
  };

  return { entries, publicKeys, references, text, namespaceMembers, module: moduleOf, routes };
}

/** Export digests for every public entry of one package golden. */
export function packageSurface({ golden, entryFiles }) {
  const files = splitGolden(golden);
  const graph = declarationGraph({ files, entryFiles });
  const digestCache = new Map();
  const digestOf = (ref) => {
    if (digestCache.has(ref.key)) return digestCache.get(ref.key);
    let digest;
    if (ref.kind === 'bare') digest = sha256(`bare ${ref.key}`).slice(0, 16);
    else if (ref.kind === 'namespace') {
      digest = sha256([...graph.namespaceMembers(ref.key)].map(([name, inner]) => `${name}=${digestOf(inner)}`).sort().join('\n')).slice(0, 16);
    } else {
      // Root text plus the transitive closure of non-public declarations.
      const parts = [`root ${graph.text(ref)}`];
      const seen = new Set([ref.key]);
      const queue = [ref];
      while (queue.length > 0) {
        for (const target of graph.references(queue.shift())) {
          if (seen.has(target.key)) continue;
          seen.add(target.key);
          if (target.kind !== 'declaration' || graph.publicKeys.has(target.key)) continue;
          parts.push(`${target.name} ${graph.text(target)}`);
          queue.push(target);
        }
      }
      digest = sha256([parts[0], ...parts.slice(1).sort()].join('\n')).slice(0, 16);
    }
    digestCache.set(ref.key, digest);
    return digest;
  };

  const result = new Map();
  for (const [entry, exported] of graph.entries) {
    result.set(entry, new Map([...exported].map(([name, ref]) => [name, digestOf(ref)])));
  }
  return { entries: result, files };
}

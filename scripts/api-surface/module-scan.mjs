import { tokenizer } from 'acorn';

// Tokenization omits comments and decodes string escapes. The declaration
// checker uses the same scanner, so this must also accept TypeScript tokens.
export function scanModule(source) {
  const tokens = [...tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true })];
  const imports = [], lazyImports = [], codegen = [];
  const hit = (token, rule) => codegen.push({ line: token.loc.start.line, rule });
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], next = tokens[i + 1], previous = tokens[i - 1];
    const bare = previous?.type.label !== '.' && previous?.type.label !== '?.';
    if ((token.value === 'Function' || token.value === 'eval') && bare && next?.type.label === '(') {
      hit(token, token.value === 'Function' ? 'Function constructor' : 'eval');
    }
    if ((token.value === 'process' || token.value === 'Bun') && bare
      && ['.', '?.'].includes(next?.type.label)
      && tokens[i + 2]?.value === (token.value === 'process' ? 'dlopen' : 'plugin')) {
      hit(token, token.value === 'process' ? 'process.dlopen' : 'Bun.plugin');
    }
    const isImport = token.type.label === 'import';
    const isRequire = token.value === 'require' && bare;
    if ((isImport || isRequire) && next?.type.label === '(') {
      const argument = tokens[i + 2], end = tokens[i + 3];
      if (argument?.type.label === 'string' && [')', ','].includes(end?.type.label)) {
        // require is synchronous; unlike import(), its literal edge belongs
        // to the conservative static closure, including guarded requires.
        (isImport ? lazyImports : imports).push({ specifier: argument.value, require: isRequire });
      } else {
        hit(token, isImport ? 'opaque import()' : 'opaque require()');
      }
      continue;
    }
    if (isImport && next?.type.label === 'string') imports.push({ specifier: next.value, require: false });
    if (!isImport && token.type.label !== 'export') continue;
    if (next?.type.label === '.' || next?.type.label === '(') continue;
    if (token.type.label === 'export' && !['*', '{'].includes(next?.type.label)
      && !(next?.value === 'type' && ['*', '{'].includes(tokens[i + 2]?.type.label))) continue;
    for (let j = i + 1; j < tokens.length && tokens[j].type.label !== ';'; j++) {
      if (tokens[j].value === 'from' && tokens[j + 1]?.type.label === 'string') {
        imports.push({ specifier: tokens[j + 1].value, require: false });
        break;
      }
    }
  }
  return { imports, lazyImports, codegen };
}

export function specifiers(source) {
  const { imports, lazyImports } = scanModule(source);
  return new Set([...imports, ...lazyImports].map(edge => edge.specifier));
}

import { parse, tokenizer } from 'acorn';

// Tokens decode escapes and omit comments. Declarations need tokenization;
// runtime modules additionally use the AST to distinguish calls from data.
export function scanModule(source, { declaration = false, sourceType = 'module' } = {}) {
  const tokens = [...tokenizer(source, { ecmaVersion: 'latest', sourceType: sourceType === 'auto' ? 'module' : sourceType, locations: true })];
  const imports = [], lazyImports = [], codegen = [];
  const hitPositions = new Map();
  const hit = (node, rule) => { const found = { line: node.loc.start.line, rule }; codegen.push(found); hitPositions.set(found, node.start); };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], next = tokens[i + 1], previous = tokens[i - 1];
    const bare = previous?.type.label !== '.' && previous?.type.label !== '?.';
    if ((token.value === 'process' || token.value === 'Bun') && bare
      && ['.', '?.'].includes(next?.type.label)
      && tokens[i + 2]?.value === (token.value === 'process' ? 'dlopen' : 'plugin')) {
      hit(token, token.value === 'process' ? 'process.dlopen' : 'Bun.plugin');
    }
    if (!declaration) continue;
    const isImport = token.type.label === 'import' && bare;
    if (isImport && next?.type.label === 'string') imports.push({ specifier: next.value, require: false });
    if (isImport && next?.type.label === '(' && tokens[i + 2]?.type.label === 'string') lazyImports.push({ specifier: tokens[i + 2].value, require: false });
    if ((!isImport && token.type.label !== 'export') || [':', '.', '('].includes(next?.type.label)) continue;
    if (token.type.label === 'export' && !['*', '{'].includes(next?.type.label)
      && !(next?.value === 'type' && ['*', '{'].includes(tokens[i + 2]?.type.label))) continue;
    for (let j = i + 1; j < tokens.length && tokens[j].type.label !== ';'; j++) {
      if (tokens[j].value === 'from' && tokens[j + 1]?.type.label === 'string') {
        imports.push({ specifier: tokens[j + 1].value, require: false }); break;
      }
    }
  }
  if (!declaration) {
    const parseAs = type => parse(source, { ecmaVersion: 'latest', sourceType: type, locations: true, allowReturnOutsideFunction: type === 'script' });
    let program;
    // Node 24 detects syntax for .js without an explicit package type. Both
    // supported grammars are parsed; no failed parse falls back to a text scan.
    if (sourceType === 'auto') { try { program = parseAs('module'); } catch { program = parseAs('script'); } }
    else program = parseAs(sourceType);
    const functions = new Set(['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression']);
    function bindings(node) {
      const names = new Set();
      function pattern(value) {
        if (!value) return;
        if (value.type === 'Identifier') names.add(value.name);
        else if (value.type === 'RestElement') pattern(value.argument);
        else if (value.type === 'AssignmentPattern') pattern(value.left);
        else if (value.type === 'ArrayPattern') value.elements.forEach(pattern);
        else if (value.type === 'ObjectPattern') value.properties.forEach(item => pattern(item.type === 'RestElement' ? item.argument : item.value));
      }
      if (functions.has(node.type)) { pattern(node.id); node.params.forEach(pattern); }
      if (node.type === 'CatchClause') pattern(node.param);
      function collect(value) {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach(collect); return; }
        if (value !== node && (functions.has(value.type) || value.type === 'ClassDeclaration')) { pattern(value.id); return; }
        if (value !== node && ['BlockStatement','StaticBlock','CatchClause'].includes(value.type)) return;
        if (value.type === 'VariableDeclarator') pattern(value.id);
        if (value.type === 'ImportDeclaration') value.specifiers.forEach(item => pattern(item.local));
        for (const [key, child] of Object.entries(value)) if (!['loc','start','end','type'].includes(key)) collect(child);
      }
      collect(node); return names;
    }
    function bound(scope, name) { for (let frame=scope;frame;frame=frame.parent) if(frame.names.has(name)) return true; return false; }
    function visit(node, lazy = false, immediate = false, scope = null, parent = null, role = null) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const item of node) visit(item,lazy,false,scope,parent,role); return; }
      if (functions.has(node.type) || ['Program','BlockStatement','StaticBlock','CatchClause'].includes(node.type)) scope = {names:bindings(node),parent:scope};
      if (functions.has(node.type)) lazy = lazy || !immediate;
      if (node.type === 'Identifier' && ['Function','eval'].includes(node.name) && !bound(scope,node.name)) {
        const property = ['Property','MethodDefinition','MemberExpression'].includes(parent?.type) && ['key','property'].includes(role) && !parent.computed;
        const binding = ['id','params','local','imported'].includes(role);
        const introspection = node.name === 'Function' && parent?.type === 'MemberExpression' && role === 'object' && !parent.computed && parent.property.name === 'prototype';
        if (!property && !binding && !introspection) hit(node, ['NewExpression','CallExpression'].includes(parent?.type) && role === 'callee' ? (node.name === 'Function' ? 'Function constructor' : 'eval') : `${node.name} reference`);
      }
      if (node.type === 'MemberExpression' && !node.computed && node.property.name === 'constructor'
        && node.object.type === 'MemberExpression' && !node.object.computed && node.object.property.name === 'prototype'
        && node.object.object.type === 'Identifier' && node.object.object.name === 'Function' && !bound(scope,'Function')) hit(node,'Function constructor reference');
      if (['ImportDeclaration','ExportAllDeclaration','ExportNamedDeclaration'].includes(node.type) && node.source) imports.push({specifier:node.source.value,require:false});
      if (node.type === 'ImportExpression') {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') lazyImports.push({specifier:node.source.value,require:false});
        else hit(node,'opaque import()');
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
        const argument=node.arguments[0];
        if(argument?.type==='Literal' && typeof argument.value==='string') (lazy?lazyImports:imports).push({specifier:argument.value,require:true});
        else hit(node,'opaque require()');
      }
      if(node.type==='CallExpression') {
        const callee=node.callee;
        if(functions.has(callee.type)) visit(callee,lazy,true,scope,node,'callee');
        else if(callee.type==='MemberExpression' && ['call','apply'].includes(callee.property.name) && functions.has(callee.object.type)) {
          visit(callee.object,lazy,true,scope,callee,'object'); visit(callee.property,lazy,false,scope,callee,'property');
        } else visit(callee,lazy,false,scope,node,'callee');
        visit(node.arguments,lazy,false,scope,node,'arguments'); return;
      }
      for(const [key,value] of Object.entries(node)) if(!['loc','start','end','type'].includes(key)) visit(value,lazy,false,scope,node,key);
    }
    visit(program);
    codegen.sort((a, b) => hitPositions.get(a) - hitPositions.get(b));
  }
  return { imports, lazyImports, codegen };
}

export function specifiers(source) {
  const { imports, lazyImports } = scanModule(source, { declaration: true });
  return new Set([...imports, ...lazyImports].map(edge => edge.specifier));
}

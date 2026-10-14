import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkEntryClosure, createWalker, manifestEntries } from './entry-closure.mjs';
import { scanModule } from './module-scan.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'byok-entry-closure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function write(file, source) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
  function json(file, value) { write(file, JSON.stringify(value, null, 2) + '\n'); }
  const exports = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };
  for (const name of ['client', 'protocol', 'core']) {
    json(`packages/${name}/package.json`, { name: `@byok-sdk/${name}`, type: 'module', exports,
      dependencies: name === 'client' ? { '@byok-sdk/protocol': '*' } : name === 'protocol' ? { zod: '*' } : {} });
    write(`packages/${name}/dist/index.js`, 'export const value = 1;\n');
    write(`packages/${name}/dist/index.d.ts`, 'export declare const value: 1;\n');
  }
  write('README.md', '<!-- BEGIN generated: api-surface/entries.json -->\n<!-- END generated: api-surface/entries.json -->\n');
  function policies(transform = () => {}) {
    const entries = Object.fromEntries(manifestEntries(root).map(entry => [entry.id, { kind: entry.kind,
      policy: { purpose: entry.id, budgetBytes: 10000, zod: false, codegen: false, nodeBuiltins: { workspace: true, thirdParty: true } }, facts: {} }]));
    transform(entries);
    json('api-surface/entries.json', entries);
    return entries;
  }
  function loadZod() {
    json('node_modules/zod/package.json', { name: 'zod', type: 'module', exports: { '.': { import: './index.js' } } });
    write('node_modules/zod/index.js', 'export const parse = new Function("return 1");\n');
    write('packages/protocol/dist/index.js', "export { parse } from 'zod';\n");
  }
  return { root, write, json, policies, loadZod, read: file => readFileSync(path.join(root, file), 'utf8') };
}

test('token scanner distinguishes escaped imports, lazy edges, code and ordinary data', () => {
  const scanned = scanModule("// import 'node:fs'; new Function('x');\n"
    + "const data = 'eval('; import {x} from '@byok-sdk/proto\\u0063ol';\n"
    + "export { y } from './relative.js'; import('./lazy.js'); import(variable);\n"
    + "new Function('x'); Function('x'); eval('x'); process.dlopen; Bun.plugin({});\n");
  assert.deepEqual(scanned.imports.map(edge => edge.specifier), ['@byok-sdk/protocol', './relative.js']);
  assert.deepEqual(scanned.lazyImports.map(edge => edge.specifier), ['./lazy.js']);
  assert.deepEqual(scanned.codegen.map(hit => hit.rule), ['opaque import()', 'Function constructor', 'Function constructor', 'eval', 'process.dlopen', 'Bun.plugin']);
});

test('manifest coverage includes all runtime conditional leaves, bins, imports and type targets', t => {
  const f = fixture(t);
  f.json('packages/client/package.json', { name: '@byok-sdk/client',
    exports: { '.': { types: './dist/index.d.ts', node: { import: './dist/index.js', require: './dist/require.cjs' }, browser: './dist/browser.js' } },
    bin: { example: './dist/bin.js' }, imports: { '#host': { types: './dist/host.d.ts', default: './dist/host.js' } } });
  const entries = manifestEntries(f.root).filter(entry => entry.pkg.manifest.name === '@byok-sdk/client');
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.find(entry => entry.id.includes('[node.import]')).types, ['packages/client/dist/index.d.ts']);
  assert.ok(entries.some(entry => entry.id === 'bin:example'));
  assert.ok(entries.some(entry => entry.id === '@byok-sdk/client#host'));
});

test('follows workspace exports and relative edges, records lazy edges without eager byte cost', t => {
  const f = fixture(t);
  f.write('packages/client/dist/index.js', "export { value } from '@byok-sdk/protocol'; export const lazy = () => import('./lazy.js');\n");
  f.write('packages/client/dist/lazy.js', 'export const lazy = 1;\n' + '// padding\n'.repeat(100));
  const entry = manifestEntries(f.root).find(entry => entry.id === '@byok-sdk/client');
  const result = createWalker(f.root)(entry);
  assert.equal(result.bytes, Buffer.byteLength(f.read('packages/client/dist/index.js')) + Buffer.byteLength(f.read('packages/protocol/dist/index.js')));
  assert.deepEqual(result.bareImports, ['@byok-sdk/protocol']);
  assert.deepEqual(result.lazyImports, ['./lazy.js']);
});

test('zod injection identifies the entry and protocol specifier; --update cannot bypass it', t => {
  const f = fixture(t);
  f.loadZod();
  f.write('packages/client/dist/index.js', "import '@byok-sdk/protocol';\n");
  f.policies(entries => { entries['@byok-sdk/protocol'].policy.zod = true; entries['@byok-sdk/protocol'].policy.codegen = true; });
  const before = f.read('api-surface/entries.json');
  for (const update of [false, true]) {
    const result = checkEntryClosure(f.root, { update });
    assert.ok(result.failures.some(error => /@byok-sdk\/client: zod is forbidden.*@byok-sdk\/protocol/.test(error)));
    assert.equal(f.read('api-surface/entries.json'), before);
  }
});

test('budget failure is enforced before writing any generated facts', t => {
  const f = fixture(t);
  f.policies(entries => { entries['@byok-sdk/client'].policy.budgetBytes = 1; });
  const before = f.read('api-surface/entries.json');
  for (const update of [false, true]) {
    assert.ok(checkEntryClosure(f.root, { update }).failures.some(error => /@byok-sdk\/client: closure \d+ bytes exceeds budget 1/.test(error)));
    assert.equal(f.read('api-surface/entries.json'), before);
  }
});

test('protocol negative control records third-party codegen; forbid policy rejects the same graph', t => {
  const f = fixture(t);
  f.loadZod();
  const policies = f.policies(entries => { entries['@byok-sdk/protocol'].policy.zod = true; entries['@byok-sdk/protocol'].policy.codegen = true; });
  assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
  const contract = JSON.parse(f.read('api-surface/entries.json'));
  assert.deepEqual(contract['@byok-sdk/protocol'].facts.thirdParty, ['zod']);
  assert.deepEqual(contract['@byok-sdk/protocol'].facts.codegen, [{ file: 'zod/index.js', line: 1, rule: 'Function constructor' }]);
  for (const id of Object.keys(contract)) assert.deepEqual(contract[id].policy, policies[id].policy);
  assert.deepEqual(checkEntryClosure(f.root).failures, []);
  contract['@byok-sdk/protocol'].policy.codegen = false;
  f.json('api-surface/entries.json', contract);
  assert.ok(checkEntryClosure(f.root, { update: true }).failures.some(error => /code generation is forbidden.*zod\/index.js/.test(error)));
});

for (const source of ["import 'node:fs';", "import 'fs';", "export const fs = () => import('fs');", "export {readFile} from 'fs';", "const fs = require('node:fs');"]) {
  test(`worker policy rejects builtin edge ${source}`, t => {
    const f = fixture(t);
    f.write('packages/client/dist/index.js', source);
    f.policies(entries => { entries['@byok-sdk/client'].policy.nodeBuiltins.workspace = false; });
    assert.ok(checkEntryClosure(f.root, { update: true }).failures.some(error => /Node builtins are forbidden/.test(error)));
  });
}

test('missing policies and orphan policies fail under --update', t => {
  const f = fixture(t);
  const contract = f.policies();
  delete contract['@byok-sdk/client'];
  contract.orphan = { policy: {} };
  f.json('api-surface/entries.json', contract);
  const errors = checkEntryClosure(f.root, { update: true }).failures;
  assert.ok(errors.some(error => /@byok-sdk\/client: missing entry policy/.test(error)));
  assert.ok(errors.some(error => /orphan: orphan entry policy/.test(error)));
});

test('facts and README drift both fail; only facts and the generated region update', t => {
  const f = fixture(t);
  f.policies();
  assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
  f.write('packages/client/dist/index.js', "import 'node:fs';\n");
  assert.ok(checkEntryClosure(f.root).failures.some(error => /entry facts drifted/.test(error)));
  assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
  f.write('README.md', f.read('README.md').replace('| Purpose |', '| Changed |'));
  assert.ok(checkEntryClosure(f.root).failures.some(error => /table drifted/.test(error)));
});

test('rejects undeclared dependencies and unavailable workspace exports', t => {
  const f = fixture(t);
  f.policies();
  for (const [specifier, expected] of [['missing', /undeclared runtime dependency missing/], ['@byok-sdk/protocol/private', /unexported specifier/]]) {
    f.write('packages/client/dist/index.js', `import '${specifier}';\n`);
    assert.ok(checkEntryClosure(f.root, { update: true }).failures.some(error => expected.test(error)));
  }
});

test('rejects missing literal lazy targets and relative or symlink escapes', t => {
  const f = fixture(t);
  f.policies();
  f.write('packages/client/outside.js', 'export const outside = 1;');
  for (const source of ["import '../outside.js';", "import('./missing.js');"]) {
    f.write('packages/client/dist/index.js', source);
    assert.ok(checkEntryClosure(f.root, { update: true }).failures.some(error => /module leaves dist|missing module/.test(error)));
  }
  symlinkSync('../outside.js', path.join(f.root, 'packages/client/dist/escape.js'));
  f.write('packages/client/dist/index.js', "import './escape.js';");
  assert.ok(checkEntryClosure(f.root, { update: true }).failures.some(error => /module leaves dist/.test(error)));
});

test('method import() and import-shaped data are not module edges; Function aliases are codegen evidence', () => {
  const scan = scanModule(`const table = {import: {from: 'sqlite'}}; loader.import('sqlite'); const F = Function; new F('');`);
  assert.deepEqual(scan.imports, []);
  assert.deepEqual(scan.lazyImports, []);
  assert.ok(scan.codegen.some(hit => hit.rule === 'Function reference'));
});

for (const allowed of [true, false]) test(`third-party builtins are reported and obey thirdParty:${allowed}`, t => {
  const f = fixture(t);
  f.json('packages/client/package.json', {name:'@byok-sdk/client',type:'module',exports:{'.':{types:'./dist/index.d.ts',import:'./dist/index.js'}},dependencies:{dep:'*'}});
  f.json('node_modules/dep/package.json', {name:'dep',type:'module',exports:'./index.js'});
  f.write('node_modules/dep/index.js', "import 'node:fs'; export const value=1;");
  f.write('packages/client/dist/index.js', "import 'dep';");
  f.policies(entries => { entries['@byok-sdk/client'].policy.nodeBuiltins = {workspace:false,thirdParty:allowed}; });
  for (const update of [false,true]) {
    const result=checkEntryClosure(f.root,{update});
    if (!allowed) assert.ok(result.failures.some(error=>/forbidden in thirdParty: node:fs/.test(error)));
  }
  if (allowed) {
    assert.deepEqual(checkEntryClosure(f.root,{update:true}).failures,[]);
    assert.deepEqual(JSON.parse(f.read('api-surface/entries.json'))['@byok-sdk/client'].facts.nodeBuiltins,{workspace:[],thirdParty:['node:fs']});
  }
});

test('literal getter requires stay lazy; top-level guarded calls, static blocks and IIFEs stay eager', () => {
  const source = `if(flag) require('guarded'); try {require('try-body')} catch(e) {}
    class C { static {require('static-block')} method(){require('method')} }
    const object = {get native(){return require('getter')}};
    (function(){require('iife')})(); (()=>require('arrow'))();
    (function(){require('call')}).call(this); function later(){require('later')}`;
  const scan=scanModule(source);
  assert.deepEqual(scan.imports.map(edge=>edge.specifier),['guarded','try-body','static-block','iife','arrow','call']);
  assert.deepEqual(scan.lazyImports.map(edge=>edge.specifier),['method','getter','later']);
});

test('CJS lazy getter does not resolve an absent module; eager IIFE follows and rejects builtin', t => {
  const f=fixture(t);
  f.json('packages/client/package.json',{name:'@byok-sdk/client',type:'module',exports:{'.':{types:'./dist/index.d.ts',import:'./dist/index.js'}},dependencies:{dep:'*'}});
  f.json('node_modules/dep/package.json',{name:'dep',main:'./index.cjs'});
  f.write('packages/client/dist/index.js',"import 'dep';");
  f.write('node_modules/dep/index.cjs',"Object.defineProperty(exports,'native',{get(){return require('./missing.cjs')}});");
  f.policies(entries=>{entries['@byok-sdk/client'].policy.nodeBuiltins.thirdParty=false});
  assert.deepEqual(checkEntryClosure(f.root,{update:true}).failures,[]);
  f.write('node_modules/dep/index.cjs',"(function(){require('./eager.cjs')})()");
  f.write('node_modules/dep/eager.cjs',"require('node:fs')");
  for(const update of [false,true]) assert.ok(checkEntryClosure(f.root,{update}).failures.some(error=>/forbidden in thirdParty/.test(error)));
});

test('optional dependency absence is recorded, and cannot prove a strict safety policy', t => {
  const f=fixture(t);
  f.json('packages/client/package.json',{name:'@byok-sdk/client',type:'module',exports:{'.':{types:'./dist/index.d.ts',import:'./dist/index.js'}},optionalDependencies:{absent:'*'}});
  f.write('packages/client/dist/index.js',"import 'absent';");
  f.policies(entries=>{entries['@byok-sdk/client'].policy.codegen=true});
  assert.deepEqual(checkEntryClosure(f.root,{update:true}).failures,[]);
  const contract=JSON.parse(f.read('api-surface/entries.json'));
  assert.deepEqual(contract['@byok-sdk/client'].facts.unavailableOptional,['absent']);
  contract['@byok-sdk/client'].policy.codegen=false;
  f.json('api-surface/entries.json',contract);
  for(const update of [false,true]) assert.ok(checkEntryClosure(f.root,{update}).failures.some(error=>/cannot prove optional dependency safety/.test(error)));
});

test('local Function schema constructors are not runtime codegen; a global alias remains detected', () => {
  const scan=scanModule(`const Function = schema => schema; Function({}); function f(eval){eval('data')} {const eval=x=>x; eval('data')} const E = globalThis;`, {sourceType:'script'});
  assert.deepEqual(scan.codegen,[]);
  const global=scanModule(`{const Function=x=>x; Function({})} const F=Function; new F('');`);
  assert.equal(global.codegen.filter(hit=>hit.rule==='Function reference').length,1);
});

test('Function.prototype introspection is allowed; constructor recovery still reports codegen', () => {
  assert.deepEqual(scanModule('Function.prototype.toString.call(value)').codegen,[]);
  assert.ok(scanModule("const F=Function.prototype.constructor; new F('')").codegen.some(hit=>hit.rule==='Function constructor reference'));
});

test('unresolved third-party source is explicit opacity and cannot pass strict policy', t => {
  const f=fixture(t);
  f.json('packages/client/package.json',{name:'@byok-sdk/client',type:'module',exports:{'.':{types:'./dist/index.d.ts',import:'./dist/index.js'}},dependencies:{dep:'*'}});
  f.json('node_modules/dep/package.json',{name:'dep',main:'./index.cjs'});
  f.write('packages/client/dist/index.js',"import 'dep';");
  f.write('node_modules/dep/index.cjs',"try { require('unavailable') } catch(error) {};");
  f.policies();
  for(const update of [false,true]) assert.ok(checkEntryClosure(f.root,{update}).failures.some(error=>/cannot prove.*unavailable/.test(error)));
  const contract=JSON.parse(f.read('api-surface/entries.json'));
  contract['@byok-sdk/client'].policy.codegen=true;
  f.json('api-surface/entries.json',contract);
  assert.deepEqual(checkEntryClosure(f.root,{update:true}).failures,[]);
  assert.deepEqual(JSON.parse(f.read('api-surface/entries.json'))['@byok-sdk/client'].facts.opaqueImports,['dep/index.cjs: unavailable']);
});

test('the actual adapters subpath rejects a protocol root injection under check and --update', t => {
  const f=fixture(t);
  f.loadZod();
  f.json('packages/client/package.json',{name:'@byok-sdk/client',type:'module',exports:{'.':{types:'./dist/index.d.ts',import:'./dist/index.js'},'./adapters':{types:'./dist/adapters.d.ts',import:'./dist/adapters.js'}},dependencies:{'@byok-sdk/protocol':'*'}});
  f.write('packages/client/dist/adapters.js',"import '@byok-sdk/protocol';");
  f.write('packages/client/dist/adapters.d.ts','export declare const adapter: 1;');
  f.policies(entries=>{entries['@byok-sdk/protocol'].policy.zod=true;entries['@byok-sdk/protocol'].policy.codegen=true});
  for(const update of [false,true]) assert.ok(checkEntryClosure(f.root,{update}).failures.some(error=>/@byok-sdk\/client\/adapters: zod is forbidden.*@byok-sdk\/protocol/.test(error)));
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkEntryClosure, createWalker, manifestEntries, runtimeSmokeImports } from './entry-closure.mjs';
import { scanModule } from './module-scan.mjs';
import { typesBearingEntries } from '../release/node-next-consumer-probe.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'byok-entry-closure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function write(file, source) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
  function json(file, value) { write(file, JSON.stringify(value, null, 2) + '\n'); }
  json('package.json', { private: true, workspaces: ['packages/*', 'examples/*'] });
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

test('runtime smoke includes Node exports and refuses eager and lazy Cloudflare imports', async t => {
  const f = fixture(t);
  f.policies();
  f.write('packages/client/dist/real.js', '');
  symlinkSync('real.js', path.join(f.root, 'packages/client/dist/linked.js'));
  for (const target of ['index.js', 'entry', 'linked.js']) {
    f.json('packages/client/package.json', { name: '@byok-sdk/client', type: 'module',
      exports: { '.': { types: './dist/index.d.ts', import: `./dist/${target}` } } });
    f.write(`packages/client/dist/${target}`, "export const data = 'cloudflare:workers'; export const load = () => import('./lazy.js');\n");
    f.write('packages/client/dist/lazy.js', 'export const value = 1;');
    assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
    assert.deepEqual((await runtimeSmokeImports(f.root)).node, ['@byok-sdk/client', '@byok-sdk/core', '@byok-sdk/protocol']);
    for (const source of ["import 'cloudflare:workers';", "export const load = () => import('cloudflare:workers');", "const worker = require('cloudflare:workers');"]) {
      f.write(`packages/client/dist/${target}`, source);
      assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
      await assert.rejects(() => runtimeSmokeImports(f.root), /@byok-sdk\/client: Cloudflare entry requires a reviewed runtime smoke/);
    }
  }
});

test('runtime smoke refuses non-Node export conditions even without Cloudflare imports', async t => {
  const f = fixture(t);
  for (const condition of ['node', 'import', 'require', 'default', 'workerd', 'worker', 'edge-light', 'browser', 'custom']) {
    f.json('packages/client/package.json', { name: '@byok-sdk/client', type: 'module',
      exports: { '.': { types: './dist/index.d.ts', [condition]: './dist/index.js' } } });
    f.policies();
    assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
    if (['node', 'import', 'require', 'default'].includes(condition)) assert.ok((await runtimeSmokeImports(f.root)).node.includes('@byok-sdk/client'));
    else await assert.rejects(() => runtimeSmokeImports(f.root), /non-Node export conditions require a reviewed runtime smoke/, condition);
  }
});

test('runtime smoke follows lazy relative graphs before accepting a Node entry', async t => {
  const f = fixture(t);
  f.write('packages/client/dist/index.js', "export const load = () => import('./lazy.js');");
  f.write('packages/client/dist/lazy.js', "export { worker } from './nested.js';");
  for (const source of ["export const worker = 'cloudflare:workers';", "import { WorkerEntrypoint } from 'cloudflare:workers'; export const worker = WorkerEntrypoint;"]) {
    f.write('packages/client/dist/nested.js', source);
    f.policies();
    assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
    if (source.startsWith('export')) assert.ok((await runtimeSmokeImports(f.root)).node.includes('@byok-sdk/client'));
    else await assert.rejects(() => runtimeSmokeImports(f.root), /Cloudflare entry requires a reviewed runtime smoke/);
  }
});

for (const directory of ['packages/helper', 'examples/host']) {
  test(`workerd graph treats ${directory} as SDK code through relative and symlink imports`, async t => {
    const f = fixture(t);
    f.json(`${directory}/package.json`, { name: 'helper', private: true, type: 'module', exports: './index.js' });
    mkdirSync(path.join(f.root, 'node_modules'), { recursive: true });
    symlinkSync(path.join(f.root, directory), path.join(f.root, 'node_modules/helper'), 'junction');
    f.write('packages/client/dist/index.js', "export const load = () => import('./lazy.js');");
    for (const specifier of [`../../../${directory}/index.js`, 'helper']) {
      f.write('packages/client/dist/lazy.js', `import '${specifier}';`);
      for (const source of ["export const value = 'cloudflare:workers';", "import 'cloudflare:workers';"]) {
        f.write(`${directory}/index.js`, source);
        f.policies();
        assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
        if (source.startsWith('export')) assert.ok((await runtimeSmokeImports(f.root)).node.includes('@byok-sdk/client'));
        else await assert.rejects(() => runtimeSmokeImports(f.root), /Cloudflare entry requires a reviewed runtime smoke/);
      }
    }
    f.write('packages/client/dist/lazy.js', `import '../../../${directory}/node_modules/dep/index.js';`);
    f.write(`${directory}/node_modules/dep/index.js`, "import 'cloudflare:workers';");
    assert.equal((await runtimeSmokeImports(f.root)).thirdPartyCloudflareImports.length, 1);
  });
}

test('runtime smoke checks package imports conditions as well as exports', async t => {
  const f = fixture(t);
  for (const condition of ['node', 'workerd']) {
    f.json('packages/client/package.json', { name: '@byok-sdk/client', type: 'module',
      exports: './dist/index.js', imports: { '#rt': { [condition]: './dist/runtime.js', default: './dist/index.js' } } });
    f.write('packages/client/dist/runtime.js', 'export const value = 1;');
    f.policies();
    assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
    if (condition === 'node') assert.ok((await runtimeSmokeImports(f.root)).node.includes('@byok-sdk/client'));
    else await assert.rejects(() => runtimeSmokeImports(f.root), /non-Node .* conditions require a reviewed runtime smoke/);
  }
});

test('workerd graph selects dependency exports and imports without the node condition', async t => {
  const f = fixture(t);
  f.write('packages/client/dist/index.js', "export const load = () => import('./lazy.js');");
  f.write('packages/client/dist/lazy.js', "import 'dep';");
  for (const field of ['exports', 'imports']) {
    f.json('node_modules/dep/package.json', { name: 'dep', type: 'module',
      exports: field === 'exports' ? { node: './node.js', workerd: './worker.js' } : './index.js',
      imports: { '#rt': { node: './node.js', workerd: './worker.js' } } });
    f.write('node_modules/dep/index.js', "import '#rt';");
    f.write('node_modules/dep/node.js', 'export const value = 1;');
    for (const source of ['export const value = 1;', "import 'cloudflare:workers';"]) {
      f.write('node_modules/dep/worker.js', source);
      f.policies();
      assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
      const result = await runtimeSmokeImports(f.root);
      assert.ok(result.node.includes('@byok-sdk/client'));
      assert.equal(result.thirdPartyCloudflareImports.length, source.startsWith('export') ? 0 : 1);
    }
  }
});

test('workerd graph reports condition, optional and native boundaries but rejects missing files', async t => {
  const f = fixture(t);
  f.write('packages/client/dist/index.js', "export const load = () => import('./lazy.js');");
  f.write('node_modules/dep/index.node', 'native fixture');
  for (const [exports, source, kind, conditions] of [
    [{ node: './index.js' }, "import 'dep';", 'unmatched condition boundary', ['node']],
    [{ browser: './index.js' }, "import 'dep';", 'unmatched condition boundary', ['browser']],
    [{ worker: './index.js' }, "import 'dep';", 'unmatched condition boundary', ['worker']],
    [{ browser: './index.js', node: './index.js' }, "import 'dep';", 'unmatched condition boundary', ['browser', 'node']],
    [{ types: './index.d.ts', node: './index.js' }, "import 'dep';", 'unmatched condition boundary', ['types', 'node']],
    ['./index.node', "import 'dep';", 'native boundary'],
    ['./index.js', "try { require('absent') } catch {}", 'optional package boundary'],
    ['./missing.js', "import 'dep';", null],
    ['./missing.js', "try { require('dep') } catch {}", null],
    ['./index.js', "try { require('./missing.js') } catch {}", null],

  ]) {
    f.json('node_modules/dep/package.json', { name: 'dep', type: 'module', exports });
    f.write('packages/client/dist/lazy.js', source);
    f.policies();
    assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
    if (kind) {
      const boundary = (await runtimeSmokeImports(f.root)).workerdBoundaries[0];
      assert.equal(boundary.kind, kind);
      assert.deepEqual(boundary.conditions, conditions);
    }
    else await assert.rejects(() => runtimeSmokeImports(f.root), /Could not resolve|missing module|unresolved target/);
  }
});

test('guarded package imports must resolve their internal alias and target', async t => {
  const f = fixture(t);
  f.write('packages/client/dist/index.js', "export const load = () => import('./lazy.js');");
  f.json('packages/client/dist/package.json', { type: 'module', imports: {
    '#valid': './valid.js', '#missing': './missing.js', '#optional': 'absent',
  } });
  f.write('packages/client/dist/valid.js', 'export const value = 1;');
  f.write('packages/client/dist/lazy.js', "try { require('#valid') } catch {}");
  f.policies();
  assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
  for (const specifier of ['#valid', '#nope', '#missing', '#optional']) {
    f.write('packages/client/dist/lazy.js', `try { require('${specifier}') } catch {}`);
    if (specifier === '#valid') assert.deepEqual((await runtimeSmokeImports(f.root)).workerdBoundaries, []);
    else await assert.rejects(() => runtimeSmokeImports(f.root), /missing module #/);
  }
  f.write('packages/client/dist/valid.js', "import 'cloudflare:workers';");
  f.write('packages/client/dist/lazy.js', "try { require('#valid') } catch {}");
  await assert.rejects(() => runtimeSmokeImports(f.root), /Cloudflare entry requires a reviewed runtime smoke/);
});

test('runtime smoke requires valid static and lazy import facts', async t => {
  const f = fixture(t);
  f.policies();
  assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
  const contract = JSON.parse(f.read('api-surface/entries.json'));
  for (const field of ['bareImports', 'lazyImports']) {
    for (const value of [undefined, 'cloudflare:workers', [42]]) {
      const edited = structuredClone(contract);
      edited['@byok-sdk/client'].facts[field] = value;
      f.json('api-surface/entries.json', edited);
      await assert.rejects(() => runtimeSmokeImports(f.root), /validated entry facts are required/);
    }
  }
});

test('NodeNext includes typed conditional Node exports and excludes untyped exports and JSON', async t => {
  const f = fixture(t);
  f.json('packages/client/package.json', { name: '@byok-sdk/client', type: 'module', exports: {
    '.': { types: './dist/index.d.ts', node: { import: './dist/index.js', require: './dist/index.js' } },
    './package.json': './package.json',
  } });
  f.json('packages/core/package.json', { name: '@byok-sdk/core', type: 'module', exports: './dist/index.js' });
  f.policies();
  assert.deepEqual(checkEntryClosure(f.root, { update: true }).failures, []);
  const smokeImports = await runtimeSmokeImports(f.root);
  assert.deepEqual(smokeImports.node, ['@byok-sdk/client', '@byok-sdk/core', '@byok-sdk/protocol']);
  // Selection must reuse the inspected graph, even if its files are no longer available.
  rmSync(path.join(f.root, 'packages'), { recursive: true });
  assert.deepEqual(await typesBearingEntries(f.root, smokeImports), ['@byok-sdk/client', '@byok-sdk/protocol']);
});

test('host-kit closure excludes filesystem and path builtins', () => {
  const entries = JSON.parse(readFileSync(new URL('../../api-surface/entries.json', import.meta.url), 'utf8'));
  const { policy, facts } = entries['@byok-sdk/bot-collaboration/host-kit'];
  assert.deepEqual(policy.nodeBuiltins.forbidden, ['fs', 'path']);
  assert.deepEqual(facts.nodeBuiltins.workspace, ['async_hooks', 'crypto']);
  assert.deepEqual(facts.nodeBuiltins.thirdParty, []);
});

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

for (const specifier of ['fs', 'node:fs', 'path', 'node:path']) {
  for (const layer of ['workspace', 'thirdParty']) {
    test(`specific builtin policy rejects ${specifier} in ${layer}`, t => {
      const f = fixture(t);
      if (layer === 'workspace') {
        f.write('packages/client/dist/index.js', `import '${specifier}';\n`);
      } else {
        f.json('packages/client/package.json', { name: '@byok-sdk/client', type: 'module',
          exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } }, dependencies: { dep: '*' } });
        f.json('node_modules/dep/package.json', { name: 'dep', type: 'module', exports: './index.js' });
        f.write('node_modules/dep/index.js', `import '${specifier}';\n`);
        f.write('packages/client/dist/index.js', "import 'dep';\n");
      }
      f.policies(entries => { entries['@byok-sdk/client'].policy.nodeBuiltins.forbidden = ['node:fs', 'path']; });
      for (const update of [false, true]) {
        assert.ok(checkEntryClosure(f.root, { update }).failures.some(error => error.includes(`Node builtins are forbidden in ${layer}: ${specifier}`)));
      }
    });
  }
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

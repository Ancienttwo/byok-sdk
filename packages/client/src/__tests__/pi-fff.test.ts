import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const clientRoot = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(clientRoot, 'node_modules/.byok-fff-test-'));
const root = mkdtempSync(join(tmpdir(), 'bfff-'));
beforeAll(() => mkdirSync(join(root, 'tmp')));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// A child owns its environment and real native libraries. Source execution or a
// mocked finder alone would miss the shipped TS/native resolution boundary.
const setup = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createAgentSession,createAgentSessionServices,createAgentSessionRuntime,SessionManager} from '@earendil-works/pi-coding-agent';
import {createByokFffExtension,piFffToolsSelected} from ${JSON.stringify(join(clientRoot, 'dist/adapters/pi/fff-extension.js'))};
const root=fs.mkdtempSync(path.join(process.env.FFF_TEST_ROOT,'case-'));
const cwd=path.join(root,'workspace'), agentDir=path.join(root,'agent'), external=path.join(root,'external');
for(const dir of [cwd,agentDir,external])fs.mkdirSync(dir);
fs.writeFileSync(path.join(cwd,'alpha-search.ts'),'export const token = "FFF_LOCAL_FIXTURE_TOKEN";\\n');
fs.writeFileSync(path.join(cwd,'.gitignore'),'ignored/\\n');
fs.mkdirSync(path.join(cwd,'ignored'));
fs.writeFileSync(path.join(cwd,'ignored/secret.ts'),'FFF_IGNORED_FIXTURE_TOKEN\\n');
fs.writeFileSync(path.join(external,'outside-search.ts'),'FFF_EXTERNAL_FIXTURE_TOKEN\\n');
execFileSync('git',['init','--quiet'],{cwd});execFileSync('git',['add','.'],{cwd});
fs.writeFileSync(path.join(agentDir,'pi-fff.json'),'{invalid json');
const poison={PI_CODING_AGENT_DIR:agentDir,PI_FFF_MODE:'override',PI_FFF_MULTIGREP:'1',FFF_FRECENCY_DB:path.join(root,'poison/frecency'),FFF_HISTORY_DB:path.join(root,'poison/history'),FFF_FOLLOW_SYMLINKS:'0'};
Object.assign(process.env,poison);
const notifications=[], errors=[];
let factory=createByokFffExtension;
const ui=new Proxy({notify(message){notifications.push(message);},setStatus(){}}, {get(target,key){return target[key]??(()=>{});}});
const dirs=()=>fs.readdirSync(os.tmpdir()).filter(name=>name.startsWith('byok-pi-fff-')).sort();
async function start(selection={}, bind=true, sessionCwd=cwd) {
  const manager=SessionManager.inMemory(sessionCwd);
  manager.appendCustomEntry('fff-mode',{mode:'override'});
  const runtime=await createAgentSessionRuntime(async target=>{
    const services=await createAgentSessionServices({cwd:sessionCwd,agentDir,modelRuntimeSignal:AbortSignal.timeout(15000),resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:piFffToolsSelected(selection)?[factory()]:[]}});
    assert.deepEqual(services.resourceLoader.getExtensions().errors,[]);
    const created=await createAgentSession({cwd:sessionCwd,agentDir,sessionManager:target.sessionManager,modelRuntime:services.modelRuntime,settingsManager:services.settingsManager,resourceLoader:services.resourceLoader,...selection});
    return {...created,services};
  }, {cwd:sessionCwd,agentDir,sessionManager:manager});
  const nativeBefore=runtime.session.getAllTools().filter(tool=>['find','grep'].includes(tool.name));
  if(bind)await runtime.session.bindExtensions({mode:'rpc',uiContext:ui,onError:error=>errors.push(error)});
  assert.deepEqual(runtime.session.getAllTools().filter(tool=>['find','grep'].includes(tool.name)),nativeBefore);
  assert(manager.getEntries().some(entry=>entry.customType==='fff-mode'&&entry.data.mode==='override'));
  for(const [name,value]of Object.entries(poison))assert.equal(process.env[name],value);
  return runtime;
}
function tool(runtime,name){const value=runtime.session.agent.state.tools.find(tool=>tool.name===name);assert(value,'active '+name);return value;}
async function execute(runtime,name,args){const result=await tool(runtime,name).execute('fff-test-'+name,args,AbortSignal.timeout(15000));return result.content.filter(c=>c.type==='text').map(c=>c.text).join('\\n');}
`;

function probe(name: string, body: string) {
  const script = join(scratch, `${name}.mjs`);
  writeFileSync(script, setup + body + '\nconsole.log(JSON.stringify({result:"PASS"}));\n');
  const result = spawnSync(process.execPath, [script], {
    cwd: clientRoot, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, TMPDIR: join(root, 'tmp'), FFF_TEST_ROOT: root },
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain('"result":"PASS"');
}

describe('SDK-owned ordinary Pi FFF', () => {
  it('searches real files with fixed names despite global config, env and historical mode', () => {
    probe('search', `
const before=dirs();
const runtime=await start({tools:['read','grep','find','ffgrep','fffind']});
try {
  assert.deepEqual(runtime.session.getActiveToolNames().sort(),['fffind','ffgrep','find','grep','read']);
  assert((await execute(runtime,'fffind',{pattern:'alpha search'})).includes('alpha-search.ts'));
  assert((await execute(runtime,'ffgrep',{pattern:'FFF_LOCAL_FIXTURE_TOKEN'})).includes('alpha-search.ts'));
  assert((await execute(runtime,'ffgrep',{pattern:'FFF_IGNORED_FIXTURE_TOKEN'})).includes('No matches found'));
  assert((await execute(runtime,'ffgrep',{pattern:'FFF_EXTERNAL_FIXTURE_TOKEN',path:external})).includes('outside-search.ts'));
  assert((await execute(runtime,'grep',{pattern:'FFF_EXTERNAL_FIXTURE_TOKEN',path:external})).includes('outside-search.ts'));
  assert((await execute(runtime,'find',{pattern:'*.ts',path:external})).includes('outside-search.ts'));
  const owned=dirs().filter(name=>!before.includes(name));assert.equal(owned.length,1);
  assert(fs.existsSync(path.join(os.tmpdir(),owned[0],'frecency/data.mdb')));
  assert(fs.existsSync(path.join(os.tmpdir(),owned[0],'history/data.mdb')));
} finally {await runtime.dispose();}
assert.deepEqual(dirs(),before);assert.deepEqual(errors,[]);
assert(!fs.existsSync(path.join(root,'poison')));
assert.equal(fs.readFileSync(path.join(agentDir,'pi-fff.json'),'utf8'),'{invalid json');
`);
  }, 35_000);

  it('admits only default or explicit grants, preserving deny, readonly and empty selections', () => {
    probe('policy', `
const cases=[
 [{},['bash','edit','fffind','ffgrep','read','write'],true],
 [{tools:['fffind']},['fffind'],true],
 [{tools:['fffind','ffgrep'],excludeTools:['ffgrep']},['fffind'],true],
 [{excludeTools:['fffind','ffgrep']},['bash','edit','read','write'],false],
 [{tools:[]},[],false],
 [{noTools:'all'},[],false],
 [{tools:['read','grep','find','ls']},['find','grep','ls','read'],false],
];
for(const [selection,expected,selected]of cases){
 const before=dirs();assert.equal(piFffToolsSelected(selection),selected);
 const runtime=await start(selection);
 try{assert.deepEqual(runtime.session.getActiveToolNames().sort(),expected);if(!selected)assert.deepEqual(dirs(),before);}
 finally{await runtime.dispose();}assert.deepEqual(dirs(),before);
}
assert.deepEqual(errors,[]);
`);
  }, 35_000);

  it('isolates two native sessions and drains pending search before shutdown', () => {
    probe('concurrent', `
const before=dirs();const a=await start();const b=await start();
try {
 assert.equal(dirs().filter(name=>!before.includes(name)).length,2);
 const results=await Promise.all([execute(a,'fffind',{pattern:'alpha'}),execute(b,'ffgrep',{pattern:'FFF_LOCAL_FIXTURE_TOKEN'})]);
 assert(results.every(text=>text.includes('alpha-search.ts')));
 const pending=execute(a,'ffgrep',{pattern:'FFF_LOCAL_FIXTURE_TOKEN',path:external});
 const stopped=a.dispose();await pending;await stopped;
 assert.equal(dirs().filter(name=>!before.includes(name)).length,1);
 assert((await execute(b,'fffind',{pattern:'alpha'})).includes('alpha-search.ts'));
 await assert.rejects(()=>execute(a,'fffind',{pattern:'alpha'}),/shutting down/);
}finally{await a.dispose();await b.dispose();}
assert.deepEqual(dirs(),before);assert.deepEqual(errors,[]);
`);
  }, 35_000);

  it('allocates no DB before bind and releases resources after real native startup failure', () => {
    probe('failure', `
const before=dirs();
const unbound=await start({},false);assert.deepEqual(dirs(),before);
// Matches initial-model admission failure: plain disposal occurs before bind.
unbound.session.dispose();assert.deepEqual(dirs(),before);
// Copy the real released wrappers into an install missing its optional native
// platform artifacts. No source patch or fake finder is involved.
const isolated=path.join(root,'incomplete-install');fs.mkdirSync(isolated);
const modules=path.join(isolated,'node_modules');fs.mkdirSync(modules);
const originalModules=${JSON.stringify(join(clientRoot, 'node_modules'))};
for(const entry of fs.readdirSync(originalModules)){
 if(entry.startsWith('.')||entry==='@ff-labs')continue;
 fs.symlinkSync(path.join(originalModules,entry),path.join(modules,entry),'junction');
}
const require=createRequire(import.meta.url);
for(const name of ['@ff-labs/fff-node','@ff-labs/fff-bun']){
 const manifest=require.resolve(name+'/package.json');
 fs.cpSync(path.dirname(manifest),path.join(modules,name),{recursive:true,filter:source=>path.basename(source)!=='node_modules'});
}
const ffiRequire=createRequire(require.resolve('@ff-labs/fff-node/package.json'));
fs.symlinkSync(path.dirname(ffiRequire.resolve('ffi-rs/package.json')),path.join(modules,'ffi-rs'),'junction');
const isolatedFactory=path.join(isolated,'fff-extension.mjs');
fs.copyFileSync(${JSON.stringify(join(clientRoot, 'dist/adapters/pi/fff-extension.js'))},isolatedFactory);
factory=(await import(isolatedFactory)).createByokFffExtension;
const failed=await start({},false);
try{
 await failed.session.bindExtensions({mode:'rpc',uiContext:ui,onError:error=>errors.push(error)});
 assert(notifications.some(message=>message.includes('FFF init failed:')&&message.includes('fff native library not found')));
 await assert.rejects(()=>execute(failed,'fffind',{pattern:'alpha'}),/fff native library not found/);
}finally{await failed.dispose();}
assert.deepEqual(dirs(),before);
assert.deepEqual(errors,[]);
`);
  }, 35_000);
});

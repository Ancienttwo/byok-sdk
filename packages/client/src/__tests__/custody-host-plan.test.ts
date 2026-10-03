import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, lstatSync, realpathSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRuntimeDescendantPlan } from '../adapters/pi/runtime-descendant-plan';
import { configureCustodyRuntimePlan, configureCustodyExternalInstallations, custodyRuntimePlan, activateVerifiedCustodyRunner } from '../custody/external-cli-authority';
import { dispatchCustodyPiSubagentSpawn, resolveCustodyParentContext } from '../custody/custody-dispatcher';
import { encodeRunFanoutBudgetDescriptor } from '../custody/custody-vendor-bridge.js';
import { RUNTIME_DESCENDANT_EDGES, runtimeEntryFixedArgv, toolImplementationLoaderEnvValuesDigest, type ImplementationSpawnBindingV1, type ToolImplementationAttestedV1 } from '@byok-sdk/implementation-identity';
import { sixthEdgeKit } from './fixtures/sixth-edge-kit';
const kits: Awaited<ReturnType<typeof sixthEdgeKit>>[]=[];
afterEach(()=>{vi.unstubAllEnvs();configureCustodyExternalInstallations([]);for(const k of kits.splice(0))k.dispose();});
const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const stat=(file:string)=>{const s=lstatSync(file);return {dev:s.dev,ino:s.ino,size:s.size,mtimeMs:s.mtimeMs,mode:s.mode,uid:s.uid,gid:s.gid};};
async function setup() {
 const k=await sixthEdgeKit();kits.push(k);
 const entry=realpathSync(path.resolve(import.meta.dirname,'../../dist/bin/byok-pi-rpc.js'));
 const command=realpathSync(process.execPath);
 const processCwd=path.join(k.dir,'sealed-process-cwd');mkdirSync(processCwd);
 const commitments={PI_PACKAGE_DIR:k.dir,PI_CODING_AGENT_DIR:k.dir,PI_CODING_AGENT_SESSION_DIR:k.dir};
 const identity:ToolImplementationAttestedV1={kind:'attested',authority:'host-install-record',manifestRevision:'test-sdk-host',form:'interpreter+bundle',installPath:entry,closureKind:'artifact',closureDigest:hash(entry),
  interpreter:{path:command,digest:hash(command),loadCommandsDigest:createHash('sha256').update('[]').digest('hex')},launchArgv:runtimeEntryFixedArgv('pi-rpc'),launchCwd:processCwd,
  assetRoot:k.dir,assets:[{path:'fixture-resource.txt',digest:hash(path.join(k.dir,'fixture-resource.txt'))}],assetStats:[stat(path.join(k.dir,'fixture-resource.txt'))],
  installStat:stat(entry),interpreterStat:stat(command),launchEnvNamesDigest:k.installations[0]!.identity.launchEnvNamesDigest,loaderEnvValuesDigest:toolImplementationLoaderEnvValuesDigest(commitments)};
 const binding=(kind: 'pi-rpc'|'pi-subagent-runner'|'pi-subagent-print'):ImplementationSpawnBindingV1=>({format:'byok.implementation-spawn',version:1,
  identity:{...identity,launchArgv:runtimeEntryFixedArgv(kind)},command,entry,fixedArgv:runtimeEntryFixedArgv(kind),cwd:processCwd,envCommitments:commitments});
 // Fixtures use real filesystem tuples to exercise child-side remeasurement.
 // Strict root-owned install resolution is covered separately; no official installation is claimed.
 const installations=k.installations.map(item=>({...item,identity:{...item.identity,installStat:stat(item.identity.installPath),interpreterStat:stat(item.identity.interpreter!.path),assetStats:item.identity.assets!.map(a=>stat(path.join(item.identity.assetRoot!,a.path)))}}));
 const plan=createRuntimeDescendantPlan('pi-rpc',binding('pi-rpc'),{descendantPolicy:k.parent.policy,edges:RUNTIME_DESCENDANT_EDGES},
  (['pi-rpc','pi-subagent-print','pi-subagent-runner'] as const).map(kind=>({kind,template:binding(kind)})),installations)!;
 configureCustodyRuntimePlan(plan);
 vi.stubEnv('BYOK_SDK_CUSTODY_LAUNCH_RECORD',undefined);
 vi.stubEnv('PI_SUBAGENT_RUN_FANOUT_BUDGET',encodeRunFanoutBudgetDescriptor(k.budget));
 vi.stubEnv('PI_PACKAGE_DIR',k.dir);vi.stubEnv('PI_CODING_AGENT_DIR',k.dir);vi.stubEnv('PI_CODING_AGENT_SESSION_DIR',k.dir);
 vi.stubEnv('PI_SUBAGENT_MAX_DEPTH','8');vi.stubEnv('PI_SUBAGENT_MAX_SPAWNS_PER_SESSION','128');
 return {k,plan,processCwd,command,binding};
}
it('uses the verified Host policy, complete helper template and sealed process cwd; the payload keeps task cwd',async()=>{
 const {k,plan,processCwd}=await setup();
 const d=dispatchCustodyPiSubagentSpawn({child:'pi-subagent-runner',cwd:k.dir,runnerConfigPath:k.config});
 const record=JSON.parse(readFileSync(d.recordPath,'utf8'));
 expect(record.template).toEqual(plan.templates.find(row=>row.kind==='pi-subagent-runner')!.template);
 expect(record.template.identity.assetRoot).toBe(k.dir);expect(d.cwd).toBe(processCwd);expect(record.perLaunch.session.cwd).toBe(k.dir);
 vi.stubEnv('BYOK_SDK_CUSTODY_LAUNCH_RECORD',d.recordPath);vi.stubEnv('BYOK_SDK_CUSTODY_PARENT_DEPTH','0');
 expect(custodyRuntimePlan()).toEqual(plan);activateVerifiedCustodyRunner(record);
 expect(resolveCustodyParentContext(process.env).parentDepth).toBe(1);
});
it('rejects a root manifest above the verified Host fanout before a helper/record is created',async()=>{
 const {k,plan}=await setup();
 configureCustodyRuntimePlan({...plan,policy:{...plan.policy,fanout:1}});
 expect(()=>dispatchCustodyPiSubagentSpawn({child:'pi-subagent-runner',cwd:k.dir,runnerConfigPath:k.config})).toThrow('root budget exceeds verified Host fanout');
 expect(k.tasks()).toEqual([]);
});
it('runs the built SDK helper from a Host template with PI_PACKAGE_DIR through to the actual external fixture child',async()=>{
 const {k,processCwd}=await setup();
 const config={id:'host-plan-fixture',steps:[{agent:'fixture',task:'hello',runner:{type:'external-cli',adapter:'codex-exec',command:k.command},inheritProjectContext:false,inheritGlobalContext:false,inheritSkills:false}],
  resultPath:path.join(k.dir,'result.json'),cwd:k.dir,placeholder:'',asyncDir:k.dir,sessionDir:k.dir,mode:'single'};
 writeFileSync(k.config,JSON.stringify(config));
 const d=dispatchCustodyPiSubagentSpawn({child:'pi-subagent-runner',cwd:k.dir,runnerConfigPath:k.config});
 const child=spawn(d.command,[...d.args],{cwd:d.cwd,env:d.env,stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',c=>stderr+=c.toString());
 const [code]=await once(child,'close');
 expect(code,stderr).toBe(0);expect(d.cwd).toBe(processCwd);expect(k.tasks()).toHaveLength(1);
 expect(k.tasks()[0]!.home).toBe(k.dir);
});

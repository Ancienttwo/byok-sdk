import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
const refs=['1e5326eb38a3476d1a69733a43a5adb3526eba45','64e102f4f9693c487afb71f9472dc4816faeee17'];
const args=process.argv.slice(2),check=args[0]==='--check'; if(check)args.shift();
if(args.length!==2)throw new Error('Expected two pinned checkout dirs');
const norm=s=>s.replace(/\r\n/g,'\n');
const helper=norm(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),'failure-diagnostics.ts'),'utf8'));
const name='keeps an out-of-horizon routine outside the wake outbox while two Agent intents submit';
const relative='examples/host-execution-core/src/scheduling-recovery.test.ts';
const opening=`it('${name}', async () => {\n  host = await openHost();`;
const instrumented=opening+`
  const preparation: Record<string, {entered:number; settled:number; rejected:number}> = {};
  const originalPrepare = host.adapter.prepare.bind(host.adapter);
  vi.spyOn(host.adapter, 'prepare').mockImplementation(input => {
    const ref = Reflect.get(input.offer, 'agentRef') as {agentId?:string} | undefined;
    const key = ref?.agentId === 'main' ? 'main' : ref?.agentId === 'other-agent' ? 'other-agent' : 'other';
    const state = preparation[key] ??= {entered:0,settled:0,rejected:0}; state.entered++;
    const pending = originalPrepare(input);
    void pending.then(() => { state.settled++; }, () => { state.rejected++; });
    return pending;
  });`;
const anchor=`  await vi.waitFor(() => expect(host.adapter.starts).toHaveLength(2));\n});`;
const replacement=`  await withFailureSnapshot(vi.waitFor(() => expect(host.adapter.starts).toHaveLength(2)), async () => ({
    predicate:'two-distinct-agent-starts', preparation,
    starts:host.adapter.starts.map(start=>start.manifest.taskId),
    tasks:await Promise.all(['bot-after-far','other-after-far'].map(key=>hostFailureSnapshot(host,key))),
  }));\n});`;
const header="import {hostFailureSnapshot,withFailureSnapshot} from './failure-diagnostics';\n";
function overlay(raw){
 const before=norm(raw); if(before.split(opening).length!==2||before.split(anchor).length!==2)throw new Error('Anchor mismatch');
 const after=header+before.replace(opening,instrumented).replace(anchor,replacement);
 if(after.slice(header.length).replace(instrumented,opening).replace(replacement,anchor)!==before)throw new Error('Non diagnostic edit');
 const tokens=s=>[...s.matchAll(/expect\(|timeout:\s*\d+|interval:\s*\d+/g)].map(m=>m[0]);
 if(JSON.stringify(tokens(before))!==JSON.stringify(tokens(after)))throw new Error('Assertion/deadline drift'); return after;
}
const plans=refs.map((sha,i)=>{
 const cwd=resolve(args[i]); if(execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim()!==sha)throw new Error('HEAD mismatch');
 const raw=readFileSync(resolve(cwd,relative),'utf8'); if(norm(raw)!==norm(execFileSync('git',['show',`${sha}:${relative}`],{cwd,encoding:'utf8'})))throw new Error('Source drift');
 const after=overlay(raw); if(after!==overlay(norm(raw).replace(/\n/g,'\r\n')))throw new Error('CRLF mismatch');
 console.log('SCHEDULING_DIAG_CHECK',sha,'assertions/deadlines/CRLF preserved');return{cwd,sha,after};
});
if(!check){let failed=false;for(const {cwd,sha,after}of plans){
 writeFileSync(resolve(cwd,relative),after);writeFileSync(resolve(cwd,'examples/host-execution-core/src/failure-diagnostics.ts'),helper);
 let ready=true;for(const argv of [['ci'],['run','--filter','./packages/*','--if-present','build']]){
 const r=spawnSync('bun',argv,{cwd,stdio:'inherit'});console.log('SCHEDULING_SETUP_EXIT',sha,argv[0],r.status??1);if(r.error||r.status!==0){failed=true;ready=false;break;}}
 if(!ready){console.log('SCHEDULING_TEST_NOT_RUN',sha);continue;}
 const r=spawnSync('bun',['run','--cwd','examples/host-execution-core','test','src/scheduling-recovery.test.ts','-t','^'+name+'$'],{cwd,stdio:'inherit'});
 console.log('SCHEDULING_TEST_EXIT',sha,r.status??1);if(r.error||r.status!==0)failed=true;
 }if(failed)process.exitCode=1;}

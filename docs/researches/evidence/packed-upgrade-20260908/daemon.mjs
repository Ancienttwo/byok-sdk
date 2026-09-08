import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const c=JSON.parse(readFileSync(process.argv[2],'utf8'));
const req=createRequire(c.install+'/package.json');
const {createDaemonWithAdapters,SqliteLocalTaskJournal,freezeRuntimeAdapterDescriptor}=await import(c.install+'/bridge.mjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const mark=n=>writeFileSync(c.control+'/'+n, String(process.pid));
const journal=new SqliteLocalTaskJournal({storeDir:c.store,faults:{onStep(step){if(step===c.cut){mark('cut');process.kill(process.pid,'SIGKILL');}}}});
const policy={policyRevision:'metadata-status-v1',activity:{mode:'metadata-status',delivery:'latest-value'},reliable:{maxPendingEventsPerAgent:256,maxPendingBytesPerAgent:4194304,maxPendingBytesPerTenant:16777216},transfers:{workspace:'disabled',transcript:'disabled',artifact:'disabled'}};
class Session {
 constructor(input){this.input=input;this.sessionRef='fixture-'+input.manifest.taskId;this.closed=false;}
 get events(){const s=this;return {async *[Symbol.asyncIterator](){
 const server=s.input.mcpServers?.byokagentmessage;
 if(server){const child=spawn(server.command,server.args,{env:{...process.env,...server.env},stdio:['pipe','pipe','pipe']});
 await new Promise((resolve,reject)=>{const lines=createInterface({input:child.stdout});child.on('error',reject);lines.on('line',line=>{const reply=JSON.parse(line);if(reply.id===1){if(reply.error)reject(Error(JSON.stringify(reply.error)));else resolve();}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'send_agent_message',arguments:{body:'**exact durable reply**',contentType:'text/markdown'}}})+'\n');});
 const helperExit=new Promise(r=>child.on('exit',r));child.kill('SIGTERM');await helperExit;mark('message-staged');
 }
 while(!s.closed){if(existsSync(c.control+'/finish')){yield {type:'progress',text:'exact fixture terminal'};yield {type:'turn_end'};return;}await delay(10);}
 }}};
 async close(){this.closed=true;} async interrupt(){} async steer(){} async followUp(){} async resolveApproval(){throw Error('no approvals');}
}
const adapter={descriptor:freezeRuntimeAdapterDescriptor({id:'pi',supportsDispatchSelection:true,capabilities:{steer:true,resume:true,approvalInteractive:false,mcpToolsets:true,permissionModes:['auto']},environmentRequirements:{credentialNames:[]}}),async detect(){return {kind:'available',version:'fixture',authPresent:true};},async prepare(){return {kind:'prepared',operation:{start:async input=>{if(c.cut==='before-runtime'){mark('before-runtime');await new Promise(()=>{});}appendFileSync(c.control+'/starts.jsonl',JSON.stringify({taskId:input.manifest.taskId,pid:process.pid})+'\n');return new Session(input);}}};}};
mkdirSync(c.control,{recursive:true});
const daemon=createDaemonWithAdapters({localAgentRelease:{version:'0.0.0-packed-fixture'},productName:'Packed upgrade fixture',productId:c.productId,serverUrl:c.url,workspaceRoot:c.workspace,storeDir:c.store,hostedJournal:{mode:'sqlite'},agentHome:{hostStorageRoot:c.store+'/agent-home'},agentEgress:{policy}},[adapter],{hostedJournal:{journal},longPoll:{retryDelayMs:20,idleDelayMs:10}});
if(c.action==='unpair'){await daemon.unpair();await journal.close();process.exit(0);}
if(c.code)await daemon.pair(c.code);
await daemon.start();console.log(JSON.stringify({ready:true,deviceId:daemon.status().deviceId}));
createInterface({input:process.stdin}).on('line',async line=>{if(line==='stop'){await daemon.stop();await journal.close();console.log(JSON.stringify({stopped:true}));process.exit(0);}});

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,readFileSync,writeFileSync,existsSync,mkdtempSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const root=resolve(process.argv[2]??'_ops/packed-upgrade');
const evidence=dirname(fileURLToPath(import.meta.url));
const req=createRequire(root+'/old/package.json');
const {createInMemoryByokCloud,tenantId}=await import(root+'/old/bridge.mjs');
const {serve}=await import(root+'/old/bridge.mjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+15000;while(Date.now()<end){const v=await fn();if(v)return v;await delay(20);}throw Error('timeout: '+label);}
const policy={policyRevision:'metadata-status-v1',activity:{mode:'metadata-status',delivery:'latest-value'},reliable:{maxPendingEventsPerAgent:256,maxPendingBytesPerAgent:4194304,maxPendingBytesPerTenant:16777216},transfers:{workspace:'disabled',transcript:'disabled',artifact:'disabled'}};
function launch(c){const config=c.control+'/'+randomUUID()+'.json';writeFileSync(config,JSON.stringify(c));const child=spawn(process.execPath,[evidence+'/daemon.mjs',config],{env:{...process.env,BYOK_TEST_DEVICE_CREDENTIAL_STORE:''},stdio:['pipe','pipe','pipe']});const messages=[];let stderr='';child.stderr.on('data',b=>stderr+=b);createInterface({input:child.stdout}).on('line',line=>{try{messages.push(JSON.parse(line));}catch{}});const exited=new Promise(r=>child.on('exit',(code,signal)=>r({code,signal})));return {child,messages,exited,get stderr(){return stderr;}};}
function snapshot(store){const db=new DatabaseSync(store+'/daemon.db',{readOnly:true});try{return {tasks:db.prepare('SELECT task_id,device_id,admitted,local_state,recovery_marker FROM journal_task').all(),terminals:db.prepare('SELECT * FROM journal_terminal').all()};}finally{db.close();}}
const selected=process.argv[3];
const results=selected?JSON.parse(readFileSync(evidence+'/results.json','utf8')).results.filter(x=>x.cut!==selected):[];
for(const cut of ['append:after-commit','before-runtime','running','terminal:after-commit','confirm:after-commit','message-draft']){
 if(selected&&cut!==selected)continue;
 const dir=mkdtempSync(root+'/case-');const c={control:dir,store:dir+'/store',workspace:dir+'/workspace',productId:'packed-'+randomUUID(),install:root+'/old',cut};mkdirSync(c.workspace);const tenant=tenantId('tenant-packed');const wire=[];const consumed=[];let outage=cut==='message-draft';let polls=0;let blocked;
 const {cloud,core}=createInMemoryByokCloud({instanceProductId:c.productId,longPollHoldMs:50,longPollIntervalMs:5,agentMessage:{consume:async x=>{consumed.push(x);return {outcome:'accepted'};}}});
 await core.quota.writeEntitlement(tenant,{version:1n,hardLimitBytes:1000000000n,maxObjectBytes:100000000n,maxInlineBytes:1000000n,mailboxLimitBytes:100000000n,retentionPolicyId:'fixture'});
 const http=serve({hostname:'127.0.0.1',port:0,fetch:async request=>{if(new URL(request.url).pathname==='/byok/events')polls++;if(request.method==='POST'&&new URL(request.url).pathname==='/byok/messages'){const body=await request.clone().json();const msgs=body.messages??[];if(outage&&msgs.some(x=>x.type==='agent.message.publish')){blocked=msgs.find(x=>x.type==='agent.message.publish');return new Response('fixture outage',{status:503});}wire.push(...msgs);}return cloud.fetch(request);}});
 await until(()=>http.address(),'http ready');c.url='http://127.0.0.1:'+http.address().port;
 let old,newer;try{
 const pairing=await cloud.createPairingCode(tenant,{productId:c.productId});c.code=pairing.code;old=launch(c);
 const ready=await until(()=>old.messages.find(x=>x.ready)||(old.child.exitCode!==null?Promise.reject(Error(old.stderr)):false),'old ready');delete c.code;
 const ref={agentId:'agent-packed',profileRevision:'profile-v1'};
 const offer=cut==='message-draft'?await cloud.enqueueFreshAgentEgressOffer(tenant,ready.deviceId,{agentMessageContext:{destinationBinding:'fixture-conversation',freshnessCursor:'fixture-turn'},payload:{instruction:'publish',policy:{mode:'auto'},runtime:'pi',agentRef:ref,egressPolicy:policy,messageEgress:{mode:'required',contract:'fixture.chat.v1',contentType:'text/markdown',maxBytes:100000},terminalProjection:{mode:'none'}}}):await cloud.enqueueAgentOffer(tenant,ready.deviceId,{payload:{instruction:'fixture',policy:{mode:'auto'},agentRef:ref}});
 const taskId=offer.taskId;
 if(cut==='before-runtime'){await until(()=>existsSync(dir+'/before-runtime'),'pre runtime');await until(async()=> (await cloud.readTaskAttempt(tenant,taskId))?.status==='claimed','cloud claim');old.child.kill('SIGKILL');}
 else if(cut==='running'){await until(()=>existsSync(dir+'/starts.jsonl'),'runtime start');old.child.kill('SIGKILL');}
 else if(cut==='message-draft'){await until(()=>blocked&&existsSync(dir+'/message-staged'),'outbox staged before cloud admission');assert.equal(consumed.length,0);old.child.kill('SIGKILL');}
 else if(cut.startsWith('terminal:')||cut.startsWith('confirm:')){await until(()=>existsSync(dir+'/starts.jsonl'),'runtime start');writeFileSync(dir+'/finish','finish');}
 const oldExit=await Promise.race([old.exited,delay(15000).then(()=>{throw Error('old did not exit: '+old.stderr);})]);assert.equal(oldExit.signal,'SIGKILL');
 const before=snapshot(c.store);const beforeAttempt=await cloud.readTaskAttempt(tenant,taskId);const beforeReceipt=await cloud.readTerminalReceipt(tenant,taskId);const terminalPostsBefore=wire.filter(x=>['task.complete','task.fail','task.cancelled'].includes(x.type)).length;
 outage=false;newer=launch({...c,install:root+'/new',cut:undefined});const newReady=await until(()=>newer.messages.find(x=>x.ready)||(newer.child.exitCode!==null?Promise.reject(Error(newer.stderr)):false),'new ready');assert.equal(newReady.deviceId,ready.deviceId);
 if(cut==='append:after-commit'){await until(()=>existsSync(dir+'/starts.jsonl'),'new runtime after unclaimed offer replay');writeFileSync(dir+'/finish','finish');}
 await until(()=>snapshot(c.store).terminals.some(x=>x.truth_state==='confirmed'),'new durable confirmation');
 const pollBase=polls;await until(()=>polls>=pollBase+2,'two completed poll cycles');
 const after=snapshot(c.store);const receipt=await cloud.readTerminalReceipt(tenant,taskId);const starts=existsSync(dir+'/starts.jsonl')?readFileSync(dir+'/starts.jsonl','utf8').trim().split('\n').map(JSON.parse):[];
 assert.equal(starts.length,cut==='before-runtime'?0:1);assert(after.tasks.every(x=>x.device_id===ready.deviceId));assert(receipt);
 if(before.terminals.length){assert.equal(after.terminals[0].bytes,before.terminals[0].bytes);assert.equal(after.terminals[0].payload_hash,before.terminals[0].payload_hash);}
 const terminalPostsAfter=wire.filter(x=>['task.complete','task.fail','task.cancelled'].includes(x.type)).length;
 if(cut==='confirm:after-commit')assert.equal(terminalPostsAfter,terminalPostsBefore);
 if(cut==='message-draft'){assert.equal(consumed.length,1);assert.deepEqual(consumed[0].payload,blocked.payload);}
 newer.child.stdin.write('stop\n');const stopped=await newer.exited;assert.equal(stopped.code,0);
 const safeTerm=t=>t.map(({bytes,...x})=>({...x,bytesSha256:createHash('sha256').update(bytes).digest('hex')}));
 results.push({cut,status:'PASS',deviceIdentityPreserved:true,oldExit,newExit:stopped,runtimeStarts:starts.length,cloudBefore:beforeAttempt,hadCloudReceiptBefore:!!beforeReceipt,journalBefore:{tasks:before.tasks,terminals:safeTerm(before.terminals)},journalAfter:{tasks:after.tasks,terminals:safeTerm(after.terminals)},terminalPostsBefore,terminalPostsAfter,messageConsumes:consumed.length});
 console.log(JSON.stringify({cut,status:'PASS'}));
 }catch(error){results.push({cut,status:'FAIL',error:String(error),oldStderr:old?.stderr,newStderr:newer?.stderr});console.log(JSON.stringify({cut,status:'FAIL',error:String(error)}));}
 finally{for(const p of [old,newer]){if(p&&p.child.exitCode===null&&p.child.signalCode===null){p.child.kill('SIGKILL');await p.exited;}}const clean=launch({...c,install:root+'/new',action:'unpair',cut:undefined});const ce=await clean.exited;results.at(-1).credentialCleanup=ce.code===0;http.closeAllConnections();await new Promise(r=>http.close(r));writeFileSync(evidence+'/results.json',JSON.stringify({node:process.version,oldSource:'2752ffe86c4b222e2a23e75176dd2dd3a75901bb',newSource:'6bcf659874be14ed27378d6dcb635a8a9a23a258',cloudSource:'2752ffe86c4b222e2a23e75176dd2dd3a75901bb',results},null,2)+'\n');}
 if(results.at(-1).status==='FAIL')break;
}
if(results.length!==6||results.some(x=>x.status!=='PASS'||!x.credentialCleanup))process.exitCode=1;

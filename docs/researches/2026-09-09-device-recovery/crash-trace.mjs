import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createByokServer, createHmacTokenSigner } from '@byok-sdk/server';
import { createDaemonWithAdapters, freezeRuntimeAdapterDescriptor, readDeviceEnrollmentStatus } from '@byok-sdk/client';
process.umask(0o077);
async function until(fn,label){for(let i=0;i<375;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,40));}throw new Error(`timeout ${label}`);}
const [mode,rootArg]=process.argv.slice(2);
if(mode){
 const root=rootArg;const cfg=JSON.parse(await fs.readFile(path.join(root,'config.json'),'utf8'));
 const signer=await fs.readFile(path.join(root,'signer.key'));
 let byok,http,daemon;let startupEvidence;let executionPhase='startup';
 try {
  byok=createByokServer({productId:cfg.productId,storage:{kind:'sqlite',path:path.join(root,'server.sqlite')},tokenSigner:createHmacTokenSigner(signer,{now:()=>new Date()}),longPollHoldMs:100});
  http=await new Promise(r=>{const h=serve({fetch:byok.hono.fetch,port:0,hostname:'127.0.0.1'},()=>r(h));});
  const adapter={descriptor:freezeRuntimeAdapterDescriptor({id:'pi',supportsDispatchSelection:true,requiresMcpToolsetToolObservation:false,capabilities:{steer:false,resume:false,approvalInteractive:false,mcpToolsets:false,permissionModes:['auto']},environmentRequirements:{credentialNames:[]}}),async detect(){return {kind:'available',version:'fixture-1'};},async prepare(){return {kind:'prepared',operation:{async start(input){
   // Test side effect with no credentials; fsync makes execution count survive SIGKILL.
   const fd=await fs.open(path.join(root,'execution-audit.jsonl'),'a',0o600);try{await fd.write(JSON.stringify({instruction:input.instruction,mode,executionPhase})+'\n');await fd.sync();}finally{await fd.close();}
   return {sessionRef:randomUUID(),events:(async function*(){yield {type:'turn_end'};})(),async close(){},async interrupt(){},async steer(){throw new Error('unsupported');},async followUp(){throw new Error('unsupported');},async resolveApproval(){throw new Error('unsupported');}};
  }}};}};
  const config={productId:cfg.productId,productName:'AiphaBee crash experiment',localAgentRelease:{version:'0.0.0-test.16'},serverUrl:`http://127.0.0.1:${http.address().port}`,storeDir:path.join(root,'device'),workspaceRoot:path.join(root,'workspace'),allowedRuntimes:['pi'],permissionDefaults:{mode:'auto'}};
  daemon=createDaemonWithAdapters(config,[adapter]);
  if(mode==='cleanup'){await daemon.unpair();process.send?.({type:'cleaned'});}
  else {
   let enrollment=await readDeviceEnrollmentStatus(config);
   if(mode==='first'){const code=await byok.pairing.createPairingCode({productId:cfg.productId});enrollment={state:'paired',...await daemon.pair(code.code)};}
   assert.equal(enrollment.state,'paired');
   if(mode==='replay')startupEvidence={devices:await byok.machines.list(),tasks:await byok.tasks.list(),enrollmentState:enrollment.state};
   await daemon.start();
   await until(async()=>{const m=await byok.machines.list();return m.some(x=>x.deviceId===enrollment.deviceId&&x.connected);},'connected');
   const before=await byok.tasks.list();
   const executionsBeforeDispatch=(await fs.readFile(path.join(root,'execution-audit.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).length;
   executionPhase='explicit-dispatch';
   // Same external request, deliberately no host mapping written after SDK enqueue.
   const h=await byok.dispatch({deviceId:enrollment.deviceId,instruction:cfg.request,runtime:'pi',policy:{mode:'auto'}});
   await until(async()=>{const t=await byok.tasks.get(h.taskId);return t?.state==='Complete';},'execution complete');
   const audit=(await fs.readFile(path.join(root,'execution-audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
   if(mode==='first'){
    // Out-of-band observation for the experiment; this is not a durable host mapping.
    process.send?.({type:'crash_window',taskId:h.taskId,executions:audit.length});
    await new Promise(()=>{}); // parent SIGKILL, no graceful cleanup
   } else {
    const after=await byok.tasks.list();
    process.send?.({type:'recovered',beforeIds:before.tasks.map(t=>t.taskId),afterIds:after.tasks.map(t=>t.taskId),replayTaskId:h.taskId,executionsBeforeDispatch,audit,executions:audit.length,sameInstruction:audit.every(a=>a.instruction===cfg.request),hostMappingExists:false});
    await daemon.stop();await daemon.unpair();await byok.devices.revoke(enrollment.deviceId);
   }
  }
 }catch(e){process.send?.({type:'error',name:e.name,message:e.message,startupEvidence});process.exitCode=1;}
 finally{if(daemon)await daemon.stop();if(byok)await byok.close();if(http)await new Promise(r=>{http.close(r);http.closeAllConnections?.();});process.disconnect?.();}
} else {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aip-byok016-crash-'));await fs.chmod(root,0o700);
 await fs.writeFile(path.join(root,'config.json'),JSON.stringify({productId:`aip-crash-${randomUUID()}`,request:'outer-request-once: deterministic test side effect'}),{mode:0o600});
 await fs.writeFile(path.join(root,'signer.key'),randomBytes(32),{mode:0o600});
 const report={at:new Date().toISOString(),sdk:'unpublished device-persistence candidate based on 0.16.0',test:'real SIGKILL after SDK dispatch/execution before host mapping; restart and replay identical outer request'};
 function childRun(stage){const c=fork(import.meta.filename,[stage,root],{stdio:['ignore','ignore','pipe','ipc']});let err='';c.stderr.on('data',b=>{err+=b;});const message=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{c.kill('SIGKILL');reject(new Error('child timed out'));},25000);c.once('message',m=>{clearTimeout(timer);m.type==='error'?reject(Object.assign(new Error(m.message),{evidence:m.startupEvidence})):resolve(m);});c.once('error',reject);c.once('exit',code=>{if(code&&code!==0)reject(new Error(`child exit ${code}: ${err}`));});});return {c,message};}
 let active;
 try {
  let a=childRun('first');active=a.c;report.first=await a.message;assert.equal(report.first.type,'crash_window');
  const exit=once(a.c,'exit');a.c.kill('SIGKILL');const [,signal]=await exit;assert.equal(signal,'SIGKILL');report.killedBy=signal;
  a=childRun('replay');active=a.c;report.recovery=await a.message;await once(a.c,'exit');
  assert.equal(report.recovery.executions,2);assert.equal(report.recovery.sameInstruction,true);assert.notEqual(report.first.taskId,report.recovery.replayTaskId);assert.ok(report.recovery.beforeIds.includes(report.first.taskId));
  report.result='duplicate_dispatch_reproduced';
 }catch(e){report.result='test_failed';report.error=e.message;report.restartEvidence=e.evidence;process.exitCode=1;}
 finally {
  if(active&&active.exitCode===null&&active.signalCode===null){const ended=once(active,'exit');active.kill('SIGKILL');await ended;}
  try{const a=childRun('cleanup');report.cleanup=await a.message;await once(a.c,'exit');await fs.rm(root,{recursive:true,force:true});report.testStateRemoved=true;}catch(e){report.cleanupError=e.message;process.exitCode=1;}
  await fs.writeFile(path.join(import.meta.dirname,'crash-trace-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
 }
}

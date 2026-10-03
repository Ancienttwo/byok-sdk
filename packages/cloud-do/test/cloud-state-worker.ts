import { DurableObject } from 'cloudflare:workers';
import { CloudState, composeCloudInput } from '../src/cloud-state';
import { admitCloudInbox } from '../src/inbox-admission';
import { prepareCloudGuard } from '../src/input-guard';
import { InvocationLedger } from '../src/invocation-ledger';
import { cloudErrorResponse } from '../src/errors';

const key='CloudStatePlatformSecret0123456789Aa';
interface Operation { name:string;op:string;now:number;input?:unknown;seq?:number;seqs?:number[];stale?:number[];id?:number;after?:number;count?:number;profile?:'zai_openai'|'deepseek_direct';outcome?:'completed'|'failed'|'interrupted';text?:string;projection?:string;invocationId?:string;busy?:boolean;retrying?:boolean }
export class CloudStateDO extends DurableObject {
  readonly cloud=new CloudState(this.ctx.storage);
  readonly ledger=new InvocationLedger(this.ctx.storage);
  async alarm() {
    const guard=await prepareCloudGuard({AIPHABEE_ZAI_API_KEY:key});
    try {this.cloud.expireQueued(guard);this.cloud.retention();await this.cloud.rearmAlarm();}
    finally {guard.dispose();}
  }
  async run(input:Operation) {
    this.ledger.ensureSchema(); this.cloud.ensureSchema();
    const guard=await prepareCloudGuard({AIPHABEE_ZAI_API_KEY:key});
    try {
      switch(input.op) {
        case 'enqueue': return await this.cloud.enqueue(admitCloudInbox(input.input,input.now),guard,input.now);
        case 'read': return this.cloud.readInboxItem(input.seq!)??null;
        case 'select': return this.cloud.selectBatch(input.now,guard);
        case 'compose': return composeCloudInput(this.cloud.selectBatch(input.now,guard),[{input:'older',reply:'reply'},{input:'oldest',reply:'old reply'}]);
        case 'start': return this.cloud.startRun(input.id!,'wake',input.now+100000,guard,input.now);
        case 'claim': return this.cloud.claim(input.id!,input.seqs!,input.profile??'zai_openai',guard,input.now);
        case 'settle': return this.cloud.settleRun(input.id!,{state:input.outcome??'completed',text:input.text,requeue:input.outcome==='interrupted',errorCode:input.outcome==='failed'?'CLOUD_MODEL_REQUEST_FAILED':undefined},guard,input.now);
        case 'eligible': return this.cloud.captureEligibility(input.stale===undefined?undefined:new Set(input.stale));
        case 'reserve': this.cloud.markReservation(input.id!,'pending',guard,input.now);this.cloud.markReservation(input.id!,'held',guard,input.now);return this.cloud.readRun(input.id!);
        case 'mark': return this.ledger.failExecution(input.id!,'CLOUD_EXECUTION_INTERRUPTED');
        case 'cancel': return this.cloud.cancelQueued(input.seq!,guard,input.now);
        case 'expire': return this.cloud.expireQueued(guard,input.now);
        case 'snapshot': return this.cloud.snapshot();
        case 'events': return this.cloud.eventPage(input.after??0);
        case 'meta': return this.cloud.eventMeta();
        case 'retention': return this.cloud.retention(input.now);
        case 'alarm': return this.ctx.storage.getAlarm();
        case 'scheduling': await this.cloud.rearmAlarm({busy:input.busy,repairRetrying:input.retrying},input.now); return {alarm:await this.ctx.storage.getAlarm(),next:this.cloud.nextAlarm(input.now)};
        case 'event-batch': return this.ctx.storage.transactionSync(()=>{
          for(let i=0;i<(input.count??1);i++) this.cloud.appendEvent({eventKey:`test:${i}`,type:'test',data:{i},createdAt:input.now},guard);
          return {meta:this.cloud.eventMeta(),count:this.ctx.storage.sql.exec<{count:number}>('SELECT COUNT(*) AS count FROM cloud_events').one().count};
        });
        case 'rollback': {
          try { this.ctx.storage.transactionSync(()=>{
            this.ctx.storage.sql.exec("UPDATE cloud_inbox SET state='running' WHERE seq=?",input.seq!);
            this.cloud.appendEvent({eventKey:'rollback',type:'test',data:{ok:true},createdAt:input.now},guard);
            throw new Error('Injected failure before commit');
          }); } catch { /* This is a real transaction rollback, not a storage replacement. */ }
          return {row:this.cloud.readInboxItem(input.seq!),events:this.cloud.eventPage(0)};
        }
        case 'delivery-type': return this.ctx.storage.transactionSync(()=>{
          this.ledger.begin({invocationId:'delivery',sessionId:'session',conversationId:1,assistantEntryId:1,toolCallId:'call_1',toolName:'resolve_security',argsDigest:'args',argsJson:'{}',replay:'safe',deadlineAt:input.now+100000});
          this.ledger.finish('delivery','succeeded',{ok:true,usage:{credits:1}},undefined,input.now);
          this.cloud.setDelivery('delivery','delivered',42,56,guard,input.now);
          return {column:this.ctx.storage.sql.exec<{type:string}>("SELECT type FROM pragma_table_info('cloud_invocations') WHERE name='taskId'").one().type,
            row:this.ctx.storage.sql.exec<{taskId:number;taskType:string;entryType:string}>("SELECT taskId,typeof(taskId) AS taskType,typeof(resultEntryId) AS entryType FROM cloud_invocations WHERE invocationId='delivery'").one()};
        });
        case 'projection': return this.ctx.storage.transactionSync(()=>{
          const id=input.invocationId??'invocation';
          this.ledger.begin({invocationId:id,sessionId:'session',conversationId:1,assistantEntryId:1,toolCallId:'call_1',toolName:'resolve_security',argsDigest:'args',argsJson:'{}',replay:'safe',deadlineAt:input.now+100000});
          const row=this.ledger.finish(id,'succeeded',{ok:true,usage:{credits:1}},undefined,input.now)!;
          let keyReads = 0; let dataReads = 0;
          const changing = Object.defineProperties({}, {
            key: { enumerable: true, get() { keyReads++; return keyReads === 1 ? 'captured' : key; } },
            dataJson: { enumerable: true, get() { dataReads++; return dataReads === 1 ? '{"value":1}' : '{'; } },
          }) as { key: string; dataJson: string };
          this.cloud.projectInvocation(row,()=>input.projection==='capture-once'?changing:({key:input.projection==='key-secret'?key:input.projection==='marker'?'sdk:invocation:projection-failed':'consumer',dataJson:
            input.projection==='decoded-key-secret'?`{"${Array.from(key,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`).join('')}":"ordinary"}`:
            input.projection==='decoded-secret'?`{"text":"${Array.from(key,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`).join('')}"}`:
            input.projection==='raw-oversized'?' '.repeat(16_383)+'{}':
            input.projection==='raw-boundary'?' '.repeat(16_382)+'{}':
            input.projection==='raw-multibyte'?JSON.stringify({text:'界'.repeat(6000)}):
            input.projection==='changed'?'{"value":2}':'{"value":1}'}),guard,input.now);
          return {rows:this.ctx.storage.sql.exec('SELECT key,invocationId,state,errorCode FROM cloud_projections ORDER BY key').toArray(),events:this.cloud.eventPage(0),keyReads,dataReads};
        });
        case 'schema': return {columns:this.ctx.storage.sql.exec<{name:string}>('PRAGMA table_info(cloud_executions)').toArray().map(row=>row.name),alarm:await this.ctx.storage.getAlarm()};
        case 'audit': {
          const rows=this.ctx.storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cloud_%'").toArray();
          return {leak:rows.some(row=>JSON.stringify(this.ctx.storage.sql.exec(`SELECT * FROM ${row.name}`).toArray()).includes(key))};
        }
      }
    } finally {guard.dispose();}
  }
}
export default {async fetch(request:Request,env:{STATES:DurableObjectNamespace<CloudStateDO>}) {
  try {const input=await request.json() as Operation;return Response.json(await env.STATES.getByName(input.name).run(input));}
  catch(error) {return cloudErrorResponse(error);}
}};

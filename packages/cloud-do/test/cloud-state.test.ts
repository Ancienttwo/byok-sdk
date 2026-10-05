import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {canonicalArgs} from '../src/tools';
import {runInputSeqs} from '../src/cloud-state';
import {admitCloudInbox,INBOX_DAY} from '../src/inbox-admission';
import type {InboxRow,CloudEventRow,CloudEventMeta,RunRow,TranscriptPlan,TranscriptCursor} from '../src/cloud-state';
let mf:Miniflare;let persist:string;let script:string;
const now=Date.now()+600_000;
function runtime() {return new Miniflare({resourcePersistencePath:persist,workers:[{config:{name:'cloud-state-test',type:'worker',compatibilityDate:'2026-08-18',compatibilityFlags:['no_nodejs_compat','no_nodejs_compat_v2'],manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:script}}},exports:{CloudStateDO:{type:'durable-object',storage:'sqlite'}},env:{STATES:{type:'durable-object',workerName:'cloud-state-test',exportName:'CloudStateDO'}}}}]});}
beforeAll(async()=>{script=(await build({entryPoints:[path.resolve(import.meta.dirname,'cloud-state-worker.ts')],bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false})).outputFiles![0]!.text;persist=await mkdtemp(path.join(os.tmpdir(),'byok-cloud-state-'));mf=runtime();await mf.ready;});
afterAll(async()=>{await mf?.dispose();if(persist) await rm(persist,{recursive:true,force:true});});
async function rpc<T>(name:string,op:string,args:Record<string,unknown>={}):Promise<T> {const response=await mf.dispatchFetch('http://test/',{method:'POST',body:JSON.stringify({name,op,now,...args})});const body=await response.json() as T;if(!response.ok) throw new Error((body as {error:{code:string}}).error.code);return body;}
const enqueue=(name:string,dedupKey:string,args:Record<string,unknown>={})=>rpc<{accepted:boolean;row:InboxRow}>(name,'enqueue',{input:{dedupKey,source:'message',text:'ordinary',...args}});

describe('cloud state in actual workerd SQLite',()=>{
  it('adds execution columns to the existing ledger schema without arming an alarm',async()=>{const result=await rpc<{columns:string[];alarm:number|null}>('schema','schema');expect(result.columns).toEqual(expect.arrayContaining(['trigger','requestId','submissionId','state','reservation','eligibilityJson']));expect(result.alarm).toBeNull();});
  it('rejects unknown fields and invalid times before writes',async()=>{for(const extra of [{metadata:{}},{availableAt:now+30*INBOX_DAY+1},{availableAt:1.5},{availableAt:now,expiresAt:now},{source:'unknown'}]) await expect(enqueue('invalid','one',extra)).rejects.toThrow('CLOUD_REQUEST_INVALID');expect(await rpc('invalid','events')).toEqual([]);expect(await rpc('invalid','alarm')).toBeNull();});
  it('retains first defaults and compares a real SHA-256 digest on retries',async()=>{const a=await enqueue('dedup','one');const b=await rpc<{accepted:boolean;row:InboxRow}>('dedup','enqueue',{now:now+1000,input:{dedupKey:'one',source:'message',text:'ordinary'}});expect(b).toEqual({accepted:false,row:a.row});expect(a.row.payloadDigest).toBe(createHash('sha256').update(canonicalArgs({source:'message',text:'ordinary',profile:'zai_openai',availableAt:now,expiresAt:now+INBOX_DAY})).digest('hex'));await expect(enqueue('dedup','one',{expiresAt:now+2*INBOX_DAY})).rejects.toThrow('CLOUD_INBOX_CONFLICT');await expect(enqueue('dedup','one',{availableAt:now+2*INBOX_DAY})).rejects.toThrow('CLOUD_INBOX_CONFLICT');expect(await rpc('dedup','events')).toHaveLength(1);expect(await rpc('dedup','alarm')).toBe(now);});
  it('deduplicates an explicit expiry after time advances when availability was omitted',async()=>{
    const item={dedupKey:'expiry',source:'message',text:'ordinary',expiresAt:now+1000};
    const first=await rpc<{accepted:boolean;row:InboxRow}>('expiry-default-retry','enqueue',{input:item});
    await rpc('expiry-default-retry','cancel',{seq:first.row.seq});
    const before=await rpc<CloudEventRow[]>('expiry-default-retry','events');
    const replay=await rpc<{accepted:boolean;row:InboxRow}>('expiry-default-retry','enqueue',{input:item,now:now+2000});
    expect(replay.accepted).toBe(false);expect(replay.row).toMatchObject({availableAt:now,expiresAt:now+1000,state:'cancelled'});
    expect(await rpc('expiry-default-retry','events')).toEqual(before);
    await expect(rpc('expiry-new-invalid','enqueue',{input:item,now:now+2000})).rejects.toThrow('CLOUD_REQUEST_INVALID');
    expect(await rpc('expiry-new-invalid','events')).toEqual([]);
    expect(await rpc('expiry-new-invalid','alarm')).toBeNull();
  });
  it('rolls back both state and event on a real SQLite transaction failure',async()=>{const {row}=await enqueue('rollback','one');const result=await rpc<{row:InboxRow;events:CloudEventRow[]}>('rollback','rollback',{seq:row.seq});expect(result.row.state).toBe('queued');expect(result.events.map(row=>row.eventKey)).toEqual([`inbox:${row.seq}:accepted`]);});
  it('keeps A B A as three contiguous groups and resolves equal times by seq',async()=>{const a=await enqueue('profiles','a');const b=await enqueue('profiles','b',{profile:'deepseek_direct'});const c=await enqueue('profiles','c');expect((await rpc<InboxRow[]>('profiles','select')).map(row=>row.seq)).toEqual([a.row.seq]);await rpc('profiles','cancel',{seq:a.row.seq});expect((await rpc<InboxRow[]>('profiles','select')).map(row=>row.seq)).toEqual([b.row.seq]);await rpc('profiles','cancel',{seq:b.row.seq});expect((await rpc<InboxRow[]>('profiles','select')).map(row=>row.seq)).toEqual([c.row.seq]);});
  it('measures complete encoded input and fails a single expanding item without claim',async()=>{const {row}=await enqueue('budget','one',{text:'x'+'\u0001'.repeat(15999)});expect(await rpc('budget','select')).toEqual([]);expect(await rpc('budget','read',{seq:row.seq})).toMatchObject({state:'failed',attempts:0,payloadJson:JSON.stringify({text:'x'+'\u0001'.repeat(15999)}),errorCode:'CLOUD_INBOX_TOO_LARGE'});const a=await enqueue('multibyte','one',{text:'界'.repeat(7990)});await enqueue('multibyte','two',{text:'界'.repeat(7990)});expect((await rpc<InboxRow[]>('multibyte','select')).map(item=>item.seq)).toEqual([a.row.seq]);});
  it('makes a pre-mark recovery snapshot immutable across workerd restarts',async()=>{await rpc('eligibility','start',{id:1});expect(await rpc('eligibility','eligible')).toMatchObject([{eligibilityJson:'{"steps":0,"aborted":0,"fatalCode":null,"wasStale":false}'}]);await rpc('eligibility','mark',{id:1});await mf.dispose();mf=runtime();await mf.ready;expect(await rpc('eligibility','eligible')).toMatchObject([{fatalCode:'CLOUD_EXECUTION_INTERRUPTED',eligibilityJson:'{"steps":0,"aborted":0,"fatalCode":null,"wasStale":false}'}]);});
  it('preserves original stale evidence when a second workerd instance sees no stale runs',async()=>{const name='stale-snapshot';const {row}=await enqueue(name,'one');await rpc(name,'start',{id:1});await rpc(name,'claim',{id:1,seqs:[row.seq]});const before=await rpc<RunRow[]>(name,'eligible',{stale:[1]});expect(before).toMatchObject([{state:'running',eligibilityJson:'{"steps":0,"aborted":0,"fatalCode":null,"wasStale":true}'}]);await rpc(name,'mark',{id:1});await mf.dispose();mf=runtime();await mf.ready;const after=await rpc<RunRow[]>(name,'eligible',{stale:[]});expect(after).toMatchObject([{state:'running',fatalCode:'CLOUD_EXECUTION_INTERRUPTED',eligibilityJson:before[0]!.eligibilityJson}]);expect(JSON.parse(after[0]!.eligibilityJson!)).toEqual({steps:0,aborted:0,fatalCode:null,wasStale:true});});
  it('requeues zero-step claims three times and fails the fourth claim',async()=>{const {row}=await enqueue('attempts','one');for(let id=1;id<=4;id++){await rpc('attempts','start',{id});const claimed=await rpc<InboxRow[]>('attempts','claim',{id,seqs:[row.seq]});if(id<4){expect(claimed).toHaveLength(1);await rpc('attempts','settle',{id,outcome:'interrupted'});}else expect(claimed).toEqual([]);}expect(await rpc('attempts','read',{seq:row.seq})).toMatchObject({state:'failed',attempts:4,payloadJson:JSON.stringify({text:'ordinary'}),errorCode:'CLOUD_WAKE_EXHAUSTED'});});
  it('settles a run and releases a committed reservation once',async()=>{const {row}=await enqueue('settle','one');await rpc('settle','start',{id:1});await rpc('settle','reserve',{id:1});await rpc('settle','claim',{id:1,seqs:[row.seq]});const first=await rpc<RunRow>('settle','settle',{id:1,text:'answer'});expect(first.state).toBe('completed');expect(first.reservation).toBe('released');await rpc('settle','settle',{id:1,text:'answer'});expect(await rpc('settle','read',{seq:row.seq})).toMatchObject({state:'done',payloadJson:JSON.stringify({text:'ordinary'})});const events=await rpc<CloudEventRow[]>('settle','events');expect(events.filter(row=>row.type==='run.completed')).toHaveLength(1);expect(events.filter(row=>row.type==='run.reservation'&&JSON.parse(row.dataJson).action==='release')).toHaveLength(1);});
  it('uses expiry for queue admission and interrupted requeue without replacing a claimed run outcome',async()=>{for(const [outcome,state,code] of [['completed','done',null],['failed','failed','CLOUD_MODEL_REQUEST_FAILED'],['interrupted','expired','CLOUD_INBOX_EXPIRED']]){const name=`claimed-expiry-${outcome}`;const {row}=await enqueue(name,'one',{expiresAt:now+1});await rpc(name,'start',{id:1});expect(await rpc(name,'claim',{id:1,seqs:[row.seq]})).toHaveLength(1);await rpc(name,'settle',{id:1,outcome,now:now+2});expect(await rpc(name,'read',{seq:row.seq})).toMatchObject({state,errorCode:code,payloadJson:JSON.stringify({text:'ordinary'})});const events=await rpc<CloudEventRow[]>(name,'events');expect(JSON.parse(events.find(event=>event.type==='inbox.settled')!.dataJson)).toMatchObject({state,errorCode:code});}});
  it('checks projection keys and decoded Unicode through the awaited production guard',async()=>{for(const projection of ['key-secret','decoded-secret','decoded-key-secret']){const result=await rpc<{rows:Array<{errorCode:string}>;events:CloudEventRow[]}>(`guard-${projection}`,'projection',{projection});expect(result.rows).toHaveLength(1);expect(result.rows[0]!.errorCode).toBe('CLOUD_PROJECTION_FAILED');expect(result.events.map(row=>row.type)).toEqual(['projection.failed']);expect(await rpc(`guard-${projection}`,'audit')).toEqual({leak:false});}});
  it('rejects excessive raw JSON before the production guard can reduce it to a small value',async()=>{for(const projection of ['raw-oversized','raw-multibyte']){const result=await rpc<{rows:Array<{errorCode:string}>;events:CloudEventRow[]}>(`cap-${projection}`,'projection',{projection});expect(result.rows).toHaveLength(1);expect(result.rows[0]!.errorCode).toBe('CLOUD_PROJECTION_FAILED');expect(result.events.map(event=>event.type)).toEqual(['projection.failed']);}const boundary=await rpc<{rows:Array<{errorCode:string|null}>;events:CloudEventRow[]}>('cap-boundary','projection',{projection:'raw-boundary'});expect(boundary.rows).toHaveLength(1);expect(boundary.rows[0]!.errorCode).toBeNull();expect(boundary.events.map(event=>event.type)).toEqual(['projection']);});
  it('stores native numeric task and result ids with real SQLite INTEGER affinity',async()=>{const result=await rpc<{column:string;row:{taskId:number;taskType:string;entryType:string}}>('delivery-type','delivery-type');expect(result).toEqual({column:'INTEGER',row:{taskId:42,taskType:'integer',entryType:'integer'}});});
  it('captures consumer projection strings once before guard and persistence',async()=>{
    const result=await rpc<{rows:Array<{key:string;errorCode:string|null}>;events:CloudEventRow[];keyReads:number;dataReads:number}>('projection-capture','projection',{projection:'capture-once'});
    expect(result.keyReads).toBe(1);expect(result.dataReads).toBe(1);
    expect(result.rows).toMatchObject([{key:'projection:invocation:captured',errorCode:null}]);
    expect(result.events.map(event=>event.type)).toEqual(['projection']);
    expect(await rpc('projection-capture','audit')).toEqual({leak:false});
  });
  it('namespaces projection keys per invocation and marks a changed digest once',async()=>{const name='projections';await rpc(name,'projection',{invocationId:'one'});await rpc(name,'projection',{invocationId:'two'});await rpc(name,'projection',{invocationId:'one'});await rpc(name,'projection',{invocationId:'one',projection:'changed'});const result=await rpc<{rows:unknown[];events:CloudEventRow[]}>(name,'projection',{invocationId:'one',projection:'changed'});expect(result.rows).toHaveLength(3);expect(result.events.map(row=>row.type)).toEqual(['projection','projection','projection.failed']);});
  it('advances retained boundaries in batches and keeps highWater when all events expire',async()=>{await rpc('retention','event-batch',{count:650,now:now-8*INBOX_DAY});expect(await rpc('retention','retention')).toEqual({events:500,inbox:0});const meta=await rpc<CloudEventMeta>('retention','meta');expect(meta).toEqual({trimmedThrough:500,highWater:650});await expect(rpc('retention','events',{after:499})).rejects.toThrow('CLOUD_EVENT_CURSOR_EXPIRED');expect(await rpc('retention','events',{after:500})).toHaveLength(100);expect(await rpc('retention','retention')).toEqual({events:150,inbox:0});expect(await rpc('retention','meta')).toEqual({trimmedThrough:650,highWater:650});expect(await rpc('retention','events')).toEqual([]);await expect(rpc('retention','events',{after:651})).rejects.toThrow('CLOUD_EVENT_CURSOR_EXPIRED');});
  it('enforces the 10000 event hard cap during one multi-event transaction',async()=>{const result=await rpc<{count:number;meta:CloudEventMeta}>('hard-cap','event-batch',{count:10005});expect(result.count).toBe(9505);expect(result.meta).toEqual({trimmedThrough:500,highWater:10005});});
  it('keeps terminal dedup keys for seven days then accepts the same key again',async()=>{const name='dedup-window';const first=await enqueue(name,'one');await rpc(name,'cancel',{seq:first.row.seq});const retry=await rpc<{accepted:boolean}>(name,'enqueue',{now:now+(7*INBOX_DAY-1),input:{dedupKey:'one',source:'message',text:'ordinary'}});expect(retry.accepted).toBe(false);const fresh=await rpc<{accepted:boolean;row:InboxRow}>(name,'enqueue',{now:now+7*INBOX_DAY,input:{dedupKey:'one',source:'message',text:'ordinary'}});expect(fresh.accepted).toBe(true);expect(fresh.row.seq).toBeGreaterThan(first.row.seq);});
  it('writes only a bounded preview and never writes a rejected final text',async()=>{for(const [name,text] of [['preview','界'.repeat(24000)],['rejected-final','CloudStatePlatformSecret0123456789Aa']]){const row=(await enqueue(name!,'one')).row;await rpc(name!,'start',{id:1});await rpc(name!,'claim',{id:1,seqs:[row.seq]});await rpc(name!,'settle',{id:1,text});const event=(await rpc<CloudEventRow[]>(name!,'events')).find(row=>row.type==='run.completed')!;const data=JSON.parse(event.dataJson);if(name==='preview'){expect(data.truncated).toBe(true);expect(Buffer.byteLength(data.text)).toBeLessThanOrEqual(1024);expect(data.text).not.toContain('�');}else {expect(data.text).toBeUndefined();expect(data.errorCode).toBe('CLOUD_MODEL_RESPONSE_REJECTED');}expect(await rpc(name!,'audit')).toEqual({leak:false});}});
  it('preserves the current repair alarm generation while queued maintenance changes',async()=>{await enqueue('fence','one',{availableAt:now+1000});const original=await rpc('fence','alarm');const result=await rpc<{alarm:number}>('fence','scheduling',{busy:true,retrying:true});expect(result.alarm).toBe(original);await enqueue('fence','two',{availableAt:now+500});expect(await rpc('fence','alarm')).toBe(original);await rpc('fence','scheduling',{busy:false,retrying:false});expect(await rpc('fence','alarm')).toBe(now+500);});
});

describe('frozen inbox schema',()=>{it('rejects accessors without invoking them',()=>{let called=0;const value=Object.defineProperty({dedupKey:'one',source:'message'},'text',{enumerable:true,get(){called++;return 'text';}});expect(()=>admitCloudInbox(value)).toThrow('CLOUD_REQUEST_INVALID');expect(called).toBe(0);});});

describe('cloud 4e state contracts in actual workerd SQLite',()=>{
  const sql=(name:string,query:string)=>rpc(name,'sql',{sql:query});
  const transcript=(name:string,cursor?:TranscriptCursor,limit=2)=>rpc<TranscriptPlan>(name,'transcript',{cursor,limit});
  const startClaim=async(name:string,id:number,seq:number)=>{
    await rpc(name,'start',{id});return rpc<InboxRow[]>(name,'claim',{id,seqs:[seq]});
  };
  it('keeps admission identity immutable when the claimed batch shrinks',async()=>{
    const name='admission-shrink';
    const a=await enqueue(name,'a',{text:'first'});const b=await enqueue(name,'b',{expiresAt:now+1});const c=await enqueue(name,'c',{text:'last'});
    const admission=await rpc<{digest:string;seqs:number[]}>(name,'identity');
    const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
    expect(admission).toEqual({seqs:[a.row.seq,b.row.seq,c.row.seq],digest:sha(JSON.stringify([
      [a.row.seq,'a',sha('first'),'zai_openai'],[b.row.seq,'b',sha('ordinary'),'zai_openai'],[c.row.seq,'c',sha('last'),'zai_openai'],
    ]))});
    await rpc(name,'start',{id:1});await rpc(name,'reserve',{id:1,admission});
    await rpc(name,'cancel',{seq:a.row.seq});await rpc(name,'expire',{now:now+2});
    const claimed=await rpc<InboxRow[]>(name,'claim',{id:1,seqs:admission.seqs,now:now+2});
    expect(claimed.map(row=>row.seq)).toEqual([c.row.seq]);
    await rpc(name,'reserve',{id:1,admission:{digest:'changed',seqs:[]}});
    expect(await rpc(name,'run',{id:1})).toMatchObject({admissionDigest:admission.digest,admittedSeqs:JSON.stringify(admission.seqs)});
    expect(await rpc(name,'claimed',{id:1})).toEqual([c.row.seq]);
    await rpc(name,'settle',{id:1,outcome:'interrupted'});
    expect(await rpc(name,'claimed',{id:1})).toEqual([c.row.seq]);
  });
  it('seeds legacy links once and keeps all unknown clocks and revisions null',async()=>{
    const name='legacy-seed';const linked=await enqueue(name,'linked');const queued=await enqueue(name,'queued');
    await startClaim(name,1,linked.row.seq);await rpc(name,'start',{id:2});await rpc(name,'start',{id:3,trigger:'submit'});
    await sql(name,"DROP TABLE cloud_run_turns; ALTER TABLE cloud_executions DROP COLUMN membershipPending; UPDATE cloud_executions SET revision=NULL,settlementAck=NULL; UPDATE cloud_inbox SET revision=NULL");
    const first=await rpc<{turns:unknown[];runs:RunRow[];events:CloudEventRow[]}>(name,'ensure');
    expect(first.turns).toEqual([{runId:1,seq:linked.row.seq,claimEvent:null,releaseEvent:null}]);
    expect(first.runs.map(row=>[row.conversationId,row.membershipPending,row.revision,row.settlementAck])).toEqual([[1,1,null,null],[2,1,null,null],[3,null,null,null]]);
    expect((await transcript(name,undefined,20)).items.map(row=>row.seq)).toEqual([queued.row.seq]);
    expect(await rpc(name,'ensure')).toEqual(first);
    await rpc(name,'backfill',{id:2,seqs:[]});await rpc(name,'backfill',{id:1,seqs:[linked.row.seq,queued.row.seq]});
    const done=await rpc(name,'ensure');expect(await rpc(name,'pending')).toEqual([]);expect(await rpc(name,'ensure')).toEqual(done);
  });
  it('backfills purged history newest first and commits progress with membership',async()=>{
    const name='legacy-progress';for(const id of [1,2,3]) await rpc(name,'start',{id});
    await sql(name,'DROP TABLE cloud_run_turns; ALTER TABLE cloud_executions DROP COLUMN membershipPending');
    expect((await rpc<RunRow[]>(name,'pending')).map(row=>row.conversationId)).toEqual([3,2,1]);
    await rpc(name,'backfill',{id:3,seqs:[50]});
    await sql(name,"CREATE TRIGGER fail_backfill BEFORE UPDATE OF membershipPending ON cloud_executions WHEN NEW.conversationId=2 AND NEW.membershipPending=0 BEGIN SELECT RAISE(ABORT,'backfill failure'); END");
    await expect(rpc(name,'backfill',{id:2,seqs:[40]})).rejects.toThrow();
    expect(await rpc(name,'claimed',{id:2})).toEqual([]);
    expect((await rpc<RunRow[]>(name,'pending')).map(row=>row.conversationId)).toEqual([2,1]);
    await mf.dispose();mf=runtime();await mf.ready;
    await sql(name,'DROP TRIGGER fail_backfill');await rpc(name,'backfill',{id:2,seqs:[40,50]});await rpc(name,'backfill',{id:1,seqs:[30,40,50]});
    expect(await sql(name,'SELECT * FROM cloud_run_turns ORDER BY runId,seq')).toEqual([
      {runId:1,seq:30,claimEvent:null,releaseEvent:null},{runId:2,seq:40,claimEvent:null,releaseEvent:null},{runId:3,seq:50,claimEvent:null,releaseEvent:null},
    ]);
    const done=await rpc(name,'ensure');await rpc(name,'backfill',{id:1,seqs:[99]});expect(await rpc(name,'ensure')).toEqual(done);
    const page=await transcript(name,undefined,20);expect(page.runs.flatMap(row=>row.turns).every(turn=>turn.runId===null&&turn.state===null&&turn.revision===null)).toBe(true);
  });
  it('keeps legacy requeue expiry purge history without inventing a current owner',async()=>{
    const name='legacy-release-purge';const {row}=await enqueue(name,'one',{expiresAt:now+10});
    await startClaim(name,1,row.seq);await rpc(name,'settle',{id:1,outcome:'interrupted'});
    await rpc(name,'expire',{now:now+10});await rpc(name,'retention',{now:now+10+7*INBOX_DAY});
    await sql(name,'DROP TABLE cloud_run_turns; ALTER TABLE cloud_executions DROP COLUMN membershipPending; UPDATE cloud_executions SET settlementAck=NULL,revision=NULL');
    await rpc(name,'backfill',{id:1,seqs:[row.seq]});
    const page=await transcript(name,undefined,20);
    expect(page.items).toEqual([]);expect(page.runs[0]!.turns).toEqual([{seq:row.seq,runId:null,state:null,errorCode:null,revision:null,text:null}]);
    expect(await rpc(name,'unacked')).toEqual([]);
    expect(await rpc(name,'ack',{id:1})).toBe(false);
  });
  it('stamps fresh rows and clears durable input only for its current run',async()=>{
    const name='durable-revision';const {row}=await enqueue(name,'one',{text:'retained'});
    const accepted=(await rpc<CloudEventRow[]>(name,'events'))[0]!;expect(row.revision).toBe(accepted.seq);
    const claimed=(await startClaim(name,1,row.seq))[0]!;const events=await rpc<CloudEventRow[]>(name,'events');
    expect(claimed.revision).toBe(events.at(-1)!.seq);expect((await rpc<RunRow>(name,'run',{id:1})).revision).toBe(claimed.revision);
    expect(await rpc(name,'durable',{id:99,seqs:[row.seq]})).toMatchObject({inputDurable:0});
    expect(await rpc(name,'durable',{id:1,seqs:[row.seq]})).toMatchObject({inputDurable:1});
    await rpc(name,'settle',{id:1,outcome:'interrupted'});
    const requeued=await rpc<InboxRow>(name,'read',{seq:row.seq});expect(requeued).toMatchObject({state:'queued',runId:null,inputDurable:0,payloadJson:'{"text":"retained"}'});expect(requeued.revision!).toBeGreaterThan(claimed.revision!);
    // The client accepts the newer revision and ignores a late older running record.
    const merge=(current:InboxRow,incoming:InboxRow)=> (incoming.revision??-1)>(current.revision??-1)?incoming:current;
    expect(merge(merge(claimed,requeued),claimed)).toEqual(requeued);
    const second=(await startClaim(name,2,row.seq))[0]!;expect(second.attempts).toBe(2);expect(second.revision!).toBeGreaterThan(requeued.revision!);
    await rpc(name,'durable',{id:1,seqs:[row.seq]});expect(await rpc(name,'read',{seq:row.seq})).toMatchObject({inputDurable:0});
    await rpc(name,'durable',{id:2,seqs:[row.seq]});await rpc(name,'settle',{id:2});
    expect(await rpc(name,'read',{seq:row.seq})).toMatchObject({state:'done',payloadJson:null});
    await rpc(name,'durable',{id:2,seqs:[row.seq]});expect(await rpc(name,'read',{seq:row.seq})).toMatchObject({state:'done',payloadJson:null});
    expect((await rpc<CloudEventRow[]>(name,'events')).filter(event=>event.type==='inbox.settled')).toHaveLength(1);
  });
  it('keeps uncommitted text readable until retention and keeps memberships after purge',async()=>{
    const name='retained-text';const {row}=await enqueue(name,'one',{text:'keep text'});await startClaim(name,1,row.seq);await rpc(name,'settle',{id:1});
    expect((await transcript(name,undefined,20)).runs[0]!.turns[0]!.text).toBe('keep text');
    expect((await rpc<{inbox:InboxRow[]}>(name,'snapshot')).inbox[0]!.payloadJson).toBeNull();
    await rpc(name,'retention',{now:now+7*INBOX_DAY-1});expect(await rpc(name,'read',{seq:row.seq})).toMatchObject({payloadJson:'{"text":"keep text"}'});
    await rpc(name,'retention',{now:now+7*INBOX_DAY});expect(await rpc(name,'read',{seq:row.seq})).toBeNull();
    expect(await rpc(name,'claimed',{id:1})).toEqual([row.seq]);
    expect((await transcript(name,undefined,20)).runs[0]!.turns[0]).toMatchObject({seq:row.seq,runId:1,state:null,revision:null,text:null});
  });
  it('starts new wake and submit runs unacked and preserves a legacy terminal ack',async()=>{
    const name='initial-ack';
    expect(await rpc(name,'start',{id:1})).toMatchObject({settlementAck:0,state:'starting'});
    expect(await rpc(name,'start',{id:2,trigger:'submit'})).toMatchObject({settlementAck:0,state:'running'});
    await rpc(name,'settle',{id:2});await sql(name,'UPDATE cloud_executions SET settlementAck=NULL WHERE conversationId=2');
    await rpc(name,'ensure');expect(await rpc(name,'run',{id:2})).toMatchObject({settlementAck:null,state:'completed'});
    await rpc(name,'start',{id:2,trigger:'submit'});expect(await rpc(name,'run',{id:2})).toMatchObject({settlementAck:null,state:'completed'});
    expect(await rpc(name,'unacked')).toEqual([]);
  });
  it('commits ack event and revision together and rolls all of them back on insert failure',async()=>{
    const name='ack-atomic';await rpc(name,'start',{id:1,trigger:'submit'});await rpc(name,'settle',{id:1});
    const before=await rpc<RunRow>(name,'run',{id:1});expect(before.settlementAck).toBe(0);expect(await rpc(name,'unacked')).toMatchObject([{conversationId:1}]);
    await sql(name,"CREATE TRIGGER fail_ack BEFORE INSERT ON cloud_events WHEN NEW.type='run.settlement' BEGIN SELECT RAISE(ABORT,'ack failure'); END");
    await expect(rpc(name,'ack',{id:1})).rejects.toThrow();expect(await rpc(name,'run',{id:1})).toEqual(before);
    expect((await rpc<CloudEventRow[]>(name,'events')).filter(event=>event.type==='run.settlement')).toEqual([]);
    await sql(name,'DROP TRIGGER fail_ack');expect(await rpc(name,'ack',{id:1})).toBe(true);expect(await rpc(name,'ack',{id:1})).toBe(false);
    const event=(await rpc<CloudEventRow[]>(name,'events')).at(-1)!;expect(event.type).toBe('run.settlement');expect(JSON.parse(event.dataJson)).toEqual({nativeRunId:1,ack:true});
    expect(await rpc(name,'run',{id:1})).toMatchObject({settlementAck:1,revision:event.seq});expect(await rpc(name,'unacked')).toEqual([]);
  });
  it('holds three horizon partitions through release reclaim and purge on a later run page',async()=>{
    const name='horizon-release';const s=(await enqueue(name,'s')).row;const z1=(await enqueue(name,'z1')).row;const z2=(await enqueue(name,'z2')).row;
    const y1=(await enqueue(name,'y1')).row;const y2=(await enqueue(name,'y2')).row;
    await startClaim(name,1,s.seq);await startClaim(name,2,z1.seq);await startClaim(name,3,z2.seq);
    const pass1=await transcript(name);expect(pass1.runs.map(row=>row.run.conversationId)).toEqual([3,2]);expect(pass1.items.map(row=>row.seq)).toEqual([y2.seq,y1.seq]);
    await rpc(name,'settle',{id:1,outcome:'interrupted'});
    const released=(await transcript(name,pass1.next)).runs[0]!.turns[0]!;expect(released).toMatchObject({seq:s.seq,runId:null,state:'queued'});
    const pass2=await transcript(name);expect((await transcript(name,pass2.next)).items.map(row=>row.seq)).toEqual([s.seq]);
    await startClaim(name,4,s.seq);
    const oldPass=await transcript(name,pass1.next);expect(oldPass.runs[0]!.turns[0]).toMatchObject({seq:s.seq,runId:4,state:'running'});expect(oldPass.items).toEqual([]);
    const middlePass=await transcript(name,pass2.next);expect(middlePass.runs.flatMap(row=>row.turns)).toEqual([]);expect(middlePass.items[0]).toMatchObject({seq:s.seq,runId:4,state:'running',text:'ordinary'});
    const pass3=await transcript(name);expect(pass3.runs[0]!.turns.map(turn=>turn.seq)).toEqual([s.seq]);expect((await transcript(name,pass3.next)).runs.flatMap(row=>row.turns).filter(turn=>turn.seq===s.seq)).toEqual([]);
    await rpc(name,'settle',{id:4});await rpc(name,'retention',{now:now+7*INBOX_DAY});
    // Current link after purge comes from the actual unreleased membership, not the old horizon container.
    expect((await transcript(name,pass1.next)).runs[0]!.turns[0]).toMatchObject({seq:s.seq,runId:4,state:null,revision:null});
    const release=(await sql(name,"SELECT releaseEvent FROM cloud_run_turns WHERE runId=1")) as Array<{releaseEvent:number}>;
    expect(release[0]!.releaseEvent).toBeGreaterThan(pass1.next.horizon);
  });
  it('keeps a later claim an item in the original pass and captures plans before mutation',async()=>{
    const name='horizon-claim';for(let id=1;id<=3;id++){await rpc(name,'start',{id,trigger:'submit'});await rpc(name,'settle',{id});}
    const rows:InboxRow[]=[];for(let id=4;id<=8;id++) rows.push((await enqueue(name,`item-${id}`)).row);
    const page1=await transcript(name);const fixed=await transcript(name,page1.next);
    await startClaim(name,4,rows[0]!.seq);await rpc(name,'settle',{id:4});
    const seqs=[...page1.items,...(await transcript(name,page1.next)).items,...(await transcript(name,(await transcript(name,page1.next)).next)).items].map(row=>row.seq);
    expect(seqs.sort((a,b)=>a-b)).toEqual(rows.map(row=>row.seq));expect(new Set(seqs).size).toBe(rows.length);
    expect((await transcript(name,page1.next)).runs.map(row=>row.run.conversationId)).toEqual([1]);
    expect(fixed.items.find(item=>item.seq===rows[1]!.seq)?.text).toBe('ordinary');
    const next=(await transcript(name,page1.next)).next;const final=await transcript(name,next);expect(final.items[0]).toMatchObject({seq:rows[0]!.seq,runId:4,state:'done',text:'ordinary'});
  });
  it('captures the ownership partition before a claim in the same worker call',async()=>{
    const name='synchronous-capture';const {row}=await enqueue(name,'one',{text:'captured'});await rpc(name,'start',{id:1});
    const plan=await rpc<TranscriptPlan>(name,'plan-claim',{id:1,seqs:[row.seq]});
    expect(plan.items).toMatchObject([{seq:row.seq,runId:null,state:'queued',text:'captured'}]);expect(plan.runs[0]!.turns).toEqual([]);
    expect((await transcript(name,undefined,20)).runs[0]!.turns).toMatchObject([{seq:row.seq,runId:1,state:'done',text:'captured'}]);
  });
  it('does not lower a settled revision when an idempotent start is repeated',async()=>{
    const name='revision-no-regression';await rpc(name,'start',{id:1,trigger:'submit'});await rpc(name,'settle',{id:1});await rpc(name,'ack',{id:1});
    const before=await rpc(name,'run',{id:1});await rpc(name,'start',{id:1,trigger:'submit'});expect(await rpc(name,'run',{id:1})).toEqual(before);
  });
  it('exhausts each list independently and validates all cursor fields',async()=>{
    const name='cursor-contract';for(let id=1;id<=5;id++) await rpc(name,'start',{id,trigger:'submit'});const one=(await enqueue(name,'one')).row;
    const first=await transcript(name);expect(first.next.item).toBeNull();expect(first.items.map(row=>row.seq)).toEqual([one.seq]);
    const second=await transcript(name,first.next);expect(second.items).toEqual([]);const third=await transcript(name,second.next);expect(third.next.run).toBeNull();expect((await transcript(name,third.next)).runs).toEqual([]);
    for(const cursor of [{run:1,item:1},{horizon:first.next.horizon+1,run:1,item:1},{horizon:0,run:0,item:null},{horizon:0,run:null,item:null,extra:1}]) await expect(rpc(name,'transcript',{cursor})).rejects.toThrow('CLOUD_REQUEST_INVALID');
    for(const limit of [0,51,1.5]) await expect(rpc(name,'transcript',{limit})).rejects.toThrow('CLOUD_REQUEST_INVALID');
  });
  it('pages more than fifty runs without restarting an empty item list',async()=>{
    const name='large-run-page';for(let id=1;id<=53;id++) await rpc(name,'start',{id,trigger:'submit'});
    const first=await transcript(name,undefined,50);expect(first.runs).toHaveLength(50);expect(first.next.item).toBeNull();
    const second=await transcript(name,first.next,50);expect(second.runs.map(row=>row.run.conversationId)).toEqual([3,2,1]);expect(second.next.run).toBeNull();
    expect((await transcript(name,second.next,50)).runs).toEqual([]);
  });
  it('removes released live history after an unclaimed item expires and is purged',async()=>{
    const name='released-purge';const {row}=await enqueue(name,'one',{expiresAt:now+10});await startClaim(name,1,row.seq);await rpc(name,'settle',{id:1,outcome:'interrupted'});
    await rpc(name,'expire',{now:now+10});expect((await transcript(name,undefined,20)).items[0]).toMatchObject({seq:row.seq,text:'ordinary'});
    await rpc(name,'retention',{now:now+10+7*INBOX_DAY});const result=await transcript(name,undefined,20);expect(result.items).toEqual([]);expect(result.runs[0]!.turns).toEqual([]);expect(await rpc(name,'claimed',{id:1})).toEqual([row.seq]);
  });
});

describe('committed native run input schema',()=>{
  it('reads the actual items shape and rejects malformed batches in full',()=>{
    const entry={kind:'byok.run-input',data:{items:[{seq:1,source:'message',text:'first'},{seq:2,source:'schedule',text:'second'}]}};
    expect(runInputSeqs([{kind:'pi.user'},entry])).toEqual([1,2]);
    for(const entries of [[],[{kind:'byok.run-input',data:{inbox:entry.data.items}}],[{kind:'byok.run-input',data:{items:[{seq:1}]}}],[{kind:'byok.run-input',data:{items:[...entry.data.items,entry.data.items[0]]}}],[{kind:'byok.run-input',data:{items:[{seq:1.5,source:'message',text:'bad'}]}}]]) expect(runInputSeqs(entries)).toEqual([]);
  });
});

describe('native input scalar fields',()=>{
  it('rejects malformed source values without converting them to strings',()=>{
    let conversions=0;
    const objectSource={toString(){conversions++;throw new Error('source conversion must not run');}};
    const entries=(source:unknown)=>[{kind:'byok.run-input',data:{items:[{seq:1,source:'message',text:'valid'},{seq:2,source,text:'malformed'}]}}];
    for(const source of [['message'],objectSource,null,undefined,1,true,'unknown']) expect(runInputSeqs(entries(source))).toEqual([]);
    expect(conversions).toBe(0);
    for(const source of ['message','schedule','invocation']) expect(runInputSeqs(entries(source))).toEqual([1,2]);
  });
  it('rejects seq arrays and other non-positive-safe-integer seq values for the whole batch',()=>{
    const entries=(seq:unknown)=>[{kind:'byok.run-input',data:{items:[{seq:1,source:'message',text:'valid'},{seq,source:'message',text:'malformed'}]}}];
    for(const seq of [[2],'2',null,undefined,0,-1,2.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) expect(runInputSeqs(entries(seq))).toEqual([]);
    expect(runInputSeqs(entries(2))).toEqual([1,2]);
  });
});

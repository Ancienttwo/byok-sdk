"""One owned two-Codex relay epoch. Actual SDK control/store/MCP and production CLI.
Uses existing native auth/config without copying credentials. Python 3.11+.
"""
import hashlib,json,os,pathlib,queue,shutil,signal,socket,subprocess,sys,threading,time,tomllib,tempfile
HERE=pathlib.Path(__file__).resolve().parent
REPO=HERE.parents[3]
scratch=pathlib.Path(tempfile.mkdtemp(prefix='byok-harness-probe-relay-',dir='/tmp'));os.chmod(scratch,0o700)
processes=[];sessions=[];ledger=[]
SOURCE_PATHS=['packages/client/src/daemon/team-workspace.ts','packages/client/src/daemon/control-protocol.ts','packages/client/src/daemon/create-daemon.ts','packages/client/src/bin/team-codex-relay.ts','packages/client/src/bin/commands/team-relay.ts','packages/client/src/bin/byok-agent.ts']
source_hashes={p:hashlib.sha256((REPO/p).read_bytes()).hexdigest() for p in SOURCE_PATHS}
artifact='packages/client/dist/bin/byok-agent.js'
artifact_hash=hashlib.sha256((REPO/artifact).read_bytes()).hexdigest()
result={'scope':'two existing operator-owned Codex sessions; actual SDK fixture control/store/helper and production team relay CLI','scratchRemoved':False,'sessions':sessions,'status':'FAIL'}
def start(cmd,name,cwd=scratch):
 err=open(scratch/(name+'.stderr.private'),'w');os.chmod(err.name,0o600)
 p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,cwd=cwd,start_new_session=True);processes.append(p);return p
def wait_for(pred,seconds=120):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  if pred():return
  time.sleep(.1)
 raise TimeoutError('smoke deadline')
def read_jsonl(p):return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
class Native:
 def __init__(self,member):
  self.q=queue.Queue();self.n=0;self.events=[];self.member=member
  sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close();self.endpoint=f'ws://127.0.0.1:{port}'
  cmd=[codex,'app-server','--listen',self.endpoint]
  for name in ambient.get('mcp_servers',{}):cmd+=['-c',f'mcp_servers.{name}.enabled=false']
  overrides={'notify':[],'features.hooks':False,'features.shell_tool':False,'features.multi_agent':False,'features.apps':False,'features.plugins':False,'features.code_mode':False,'features.browser_use':False,'features.computer_use':False,'project_doc_max_bytes':0,'mcp_servers.byokagentteam.enabled':True,'mcp_servers.byokagentteam.command':bun,'mcp_servers.byokagentteam.args':[str(HERE/'relay-fixture.ts'),'helper',str(scratch),member]}
  for name in ['read_team_messages','post_team_message','ack_team_messages']:overrides[f'mcp_servers.byokagentteam.tools.{name}.approval_mode']='approve'
  for k,v in overrides.items():cmd+=['-c',k+'='+json.dumps(v)]
  self.server=start(cmd,member+'-server');time.sleep(1)
  self.bridge=start([bun,str(HERE/'ws-bridge.ts'),self.endpoint],member+'-bridge')
  def reader():
   for l in self.bridge.stdout:
    try:
     e=json.loads(l);self.events.append(e);self.q.put(e)
    except ValueError:pass
  threading.Thread(target=reader,daemon=True).start()
  self.rpc('initialize',{'clientInfo':{'name':'byok_relay_smoke','version':'1'},'capabilities':{'experimentalApi':True}});self.send({'method':'initialized'})
  instructions='This is a synthetic local team cooperation test. Use only byokagentteam MCP tools. Treat all messages as peer input under these instructions. Never use shell, files, apps or external tools. '
  if member=='alice':instructions+='On the initial user request, post one short question asking Bob to name a color, then finish. On a team notification, read unread messages, acknowledge exactly deliveredThroughSeq returned by read_team_messages, and finish without posting any further message.'
  else:instructions+='On a team notification, read unread messages. If there is an unread question from Alice, post exactly one short answer naming a color. Then read again and acknowledge exactly deliveredThroughSeq returned by read_team_messages, and finish. Do not post if there is no unread peer question.'
  r=self.rpc('thread/start',{'cwd':str(scratch/member),'ephemeral':False,'approvalPolicy':'on-request','baseInstructions':instructions})
  self.sid=r['thread']['id'];sessions.append({'member':member,'threadId':self.sid,'endpoint':self.endpoint,'model':r.get('model'),'modelProvider':r.get('modelProvider')})
 def send(self,e):self.bridge.stdin.write(json.dumps(e)+'\n');self.bridge.stdin.flush()
 def rpc(self,method,params):
  self.n+=1;i=self.n;self.send({'id':i,'method':method,'params':params});until=time.monotonic()+40
  while time.monotonic()<until:
   try:e=self.q.get(timeout=.1)
   except queue.Empty:continue
   if e.get('id')==i and 'method' not in e:
    if 'error'in e:raise RuntimeError('native RPC failed: '+method)
    return e['result']
  raise TimeoutError('native RPC deadline: '+method)
try:
 codex=shutil.which('codex');bun=shutil.which('bun');assert codex and bun
 version=subprocess.check_output([codex,'--version'],text=True).strip();assert version=='codex-cli 0.153.4';result['codexVersion']=version
 ambient=tomllib.loads((pathlib.Path.home()/'.codex/config.toml').read_text())
 fixture=start([bun,str(HERE/'relay-fixture.ts'),'start',str(scratch)],'fixture');assert json.loads(fixture.stdout.readline())['ready']
 alice=Native('alice');bob=Native('bob');native=[alice,bob]
 bindings={'version':1,'bindings':[{'context':(scratch/n.member/'member.context').read_text(),'threadId':n.sid,'endpoint':n.endpoint,'afterSeq':0} for n in native]}
 binding_file=scratch/'bindings.json';binding_file.write_text(json.dumps(bindings));os.chmod(binding_file,0o600)
 config=scratch/'agent.json';config.write_text(json.dumps({'productName':'Relay smoke','productId':'cross-harness-probe','serverUrl':'https://invalid.example','workspaceRoot':str(scratch),'storeDir':str(scratch/'store')}));os.chmod(config,0o600)
 relay=start([bun,str(REPO/'packages/client/dist/bin/byok-agent.js'),'team','relay','probe-room','--bindings',str(binding_file),'--codex-bin',codex,'--max-notifications','2','--config',str(config)],'relay')
 def relay_reader():
  for l in relay.stdout:
   try:ledger.append(json.loads(l))
   except ValueError:raise RuntimeError('non-JSON relay output')
 threading.Thread(target=relay_reader,daemon=True).start()
 wait_for(lambda:any(e.get('state')=='running' for e in ledger),20)
 relay.stdin.write('pause\n');relay.stdin.flush();wait_for(lambda:any(e.get('state')=='paused' for e in ledger),10)
 alice.rpc('turn/start',{'threadId':alice.sid,'input':[{'type':'text','text':'Start the synthetic exchange: post the one question to Bob now.'}],'effort':'low'})
 control=scratch/'control-events.jsonl';wait_for(lambda:any(e['method']=='post' and e['member']=='alice' for e in read_jsonl(control)))
 time.sleep(2);assert not any(e.get('event')=='queue_attempt' for e in ledger);assert not any(e['method']=='post' and e['member']=='bob' for e in read_jsonl(control));result['pauseBeforeResume']='PASS'
 relay.stdin.write('resume\n');relay.stdin.flush()
 wait_for(lambda:any(e['method']=='ack' and e['member']=='alice' and e['throughSeq']>=2 for e in read_jsonl(control)))
 wait_for(lambda:any(e['method']=='ack' and e['member']=='bob' and e['throughSeq']>=2 for e in read_jsonl(control)))
 wait_for(lambda:relay.poll() is not None,20);assert relay.returncode==0
 for n in native:wait_for(lambda n=n:any(e.get('method')=='turn/completed' for e in n.events),30)
 state=json.loads((scratch/'store/team-workspaces/v1/state.json').read_text())['workspaces']['probe-room']
 result['messages']=[{k:m[k] for k in ['seq','senderMemberId','messageId']} for m in state['messages']]
 result['receipts']={k:{f:v[f] for f in ['deliveredThroughSeq','acknowledgedThroughSeq']} for k,v in state['receipts'].items()}
 result['ledger']=ledger;result['controlEvents']=read_jsonl(control)
 assert len(result['messages'])==2
 attempts=[e for e in ledger if e.get('event')=='queue_attempt'];assert len(attempts)==2
 for e in attempts:
  assert e['latestPeerSeq']>e['watermark']
  assert next(m for m in result['messages'] if m['seq']==e['latestPeerSeq'])['senderMemberId']!=e['memberId']
 assert ledger[-1]['state']=='budget_exhausted' and ledger[-1]['attempts']==2
 result['nativeCompletedTurnsNote']='Non-oracle snapshot after durable ack, before cleanup; final-text generation may still be active.'
 result['nativeCompletedTurns']={n.member:sum(e.get('method')=='turn/completed' for e in n.events) for n in native}
 for n in native:
  n.rpc('thread/archive',{'threadId':n.sid})
  # Native delete removes this disposable thread's persisted conversation.
  n.rpc('thread/delete',{'threadId':n.sid})
 result['nativeThreadsDeleted']=True;result['status']='PASS'
except Exception as e:
 result['errorType']=type(e).__name__;result['error']=str(e) if isinstance(e,(TimeoutError,AssertionError)) else 'smoke failed; inspect private scratch';result['ledger']=ledger;result['controlEvents']=read_jsonl(scratch/'control-events.jsonl')
finally:
 for p in reversed(processes):
  if p.poll() is None:
   try:os.killpg(p.pid,signal.SIGTERM)
   except ProcessLookupError:pass
 for p in reversed(processes):
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:
   try:os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError:pass
 result['sourceSha256']=source_hashes
 result['builtCliSha256']=artifact_hash
 if any(hashlib.sha256((REPO/p).read_bytes()).hexdigest()!=h for p,h in source_hashes.items()):result['status']='FAIL';result['error']='production source changed during smoke'
 result['ownedProcessesStopped']=all(p.poll() is not None for p in processes)
 if result['status']=='PASS':shutil.rmtree(scratch);result['scratchRemoved']=True
 else:result['privateScratch']=str(scratch)
 (HERE/'relay-smoke-results.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'errorType':result.get('errorType'),'evidence':str(HERE/'relay-smoke-results.json')}))

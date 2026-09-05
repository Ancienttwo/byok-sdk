"""Owned Codex queue probe. Python 3.11+. Native RPC/tool receipts are evidence."""
import json,os,pathlib,queue,signal,socket,subprocess,sys,threading,time,tomllib
HERE=pathlib.Path(__file__).resolve().parent
scratch=pathlib.Path(sys.argv[1]);assert scratch.name.startswith('byok-notify-probe-')
root=scratch/'codex';root.mkdir(mode=0o700,exist_ok=True)
records=[];processes=[];received=[];q=queue.Queue();counter=0
draft_mode=len(sys.argv)>2 and sys.argv[2]=='draft'
out=HERE/('codex-draft-results.json' if draft_mode else 'codex-notify-results.json');result={'harness':'codex','version':'0.153.4','scope':'dedicated app-server; native queue CLI','cases':{}}
def rec(**x):records.append({'ts':time.time(),**x});print(json.dumps(x),flush=True)
def start(cmd,name):
 err=open(root/(name+'.stderr.private'),'w');os.chmod(err.name,0o600)
 p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,cwd=root,start_new_session=True);processes.append(p);return p
def reader(p):
 with open(root/'rpc.private.jsonl','w') as f:
  os.chmod(f.name,0o600)
  for l in p.stdout:
   f.write(l);f.flush()
   try:q.put(json.loads(l))
   except ValueError:pass
def wait(pred,seconds=85):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  try:e=q.get(timeout=.1)
  except queue.Empty:continue
  received.append(e)
  if pred(e):return e
 raise TimeoutError('native event deadline')
def pump(seconds):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  try:received.append(q.get(timeout=.1))
  except queue.Empty:pass
def send(x):bridge.stdin.write(json.dumps(x)+'\n');bridge.stdin.flush()
def rpc(method,params):
 global counter
 counter+=1;i=counter;send({'id':i,'method':method,'params':params});r=wait(lambda e:e.get('id')==i and 'method' not in e,25)
 if 'error'in r:raise RuntimeError(json.dumps(r['error']))
 return r['result']
def tools():
 p=root/'tools.jsonl';return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
def toolwait(label,event='tool_exit',seconds=85):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  if any(e['label']==label and e['event']==event for e in tools()):return
  pump(.1)
 raise TimeoutError('tool event deadline '+label)
def prompt(label,tool='probe_record'):return f'Call only {tool} with label "{label}" once, then finish with DONE. This is a synthetic probe, do not call other tools.'
def enqueue(label):
 r=subprocess.run(['codex','queue','--remote',endpoint,'--thread',sid,'--message',prompt(label)],cwd=root,capture_output=True,text=True,timeout=25)
 assert r.returncode==0,(r.returncode,r.stderr[:400]);rec(event='queue_accepted',label=label,receipt=r.stdout.strip())
def turn(label,tool='probe_record'):return rpc('turn/start',{'threadId':sid,'input':[{'type':'text','text':prompt(label,tool)}],'effort':'low'})
def settled():wait(lambda e:e.get('method')=='turn/completed')
try:
 ambient=tomllib.loads((pathlib.Path.home()/'.codex/config.toml').read_text())
 sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close();endpoint=f'ws://127.0.0.1:{port}'
 cmd=['codex','app-server','--listen',endpoint]
 for name in ambient.get('mcp_servers',{}):cmd+=['-c',f'mcp_servers.{name}.enabled=false']
 overrides={'notify':[],'features.hooks':False,'features.shell_tool':False,'features.multi_agent':False,'features.apps':False,'features.plugins':False,'features.code_mode':False,'features.browser_use':False,'features.computer_use':False,'project_doc_max_bytes':0,'mcp_servers.notifyprobe.enabled':True,'mcp_servers.notifyprobe.command':sys.executable,'mcp_servers.notifyprobe.args':[str(HERE/'notify-mcp.py'),str(root)]}
 for n in ['probe_gate','probe_record']:overrides[f'mcp_servers.notifyprobe.tools.{n}.approval_mode']='approve'
 overrides['mcp_servers.notifyprobe.tools.probe_approval.approval_mode']='prompt'
 for k,v in overrides.items():cmd+=['-c',k+'='+json.dumps(v)]
 server=start(cmd,'server');time.sleep(1)
 bridge=start(['bun',str(HERE/'ws-bridge.ts'),endpoint],'bridge');threading.Thread(target=reader,args=(bridge,),daemon=True).start()
 rpc('initialize',{'clientInfo':{'name':'byok_notify_probe','version':'1'},'capabilities':{'experimentalApi':True}});send({'method':'initialized'})
 r=rpc('thread/start',{'cwd':str(root),'ephemeral':False,'approvalPolicy':'on-request','baseInstructions':'Perform exact synthetic notification probes using only notifyprobe tools. Do not use files, shell, apps or external tools. End each instruction after its requested tool.'})
 sid=r['thread']['id'];result['sessionId']=sid;rec(event='thread_created',sessionId=sid)
 if draft_mode:
  turn('idle');toolwait('idle');settled();pump(2)
  import pty,fcntl,termios,struct
  master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
  tui_env=os.environ.copy();tui_env['TERM']='xterm-256color'
  tui=subprocess.Popen(['codex','--remote',endpoint,'resume',sid,'--no-alt-screen'],stdin=slave,stdout=slave,stderr=slave,cwd=root,env=tui_env,start_new_session=True);os.close(slave);processes.append(tui)
  def terminal_reader():
   with open(root/'tui.private.bin','wb') as f:
    os.chmod(f.name,0o600)
    while True:
     try:b=os.read(master,65536)
     except OSError:return
     if not b:return
     f.write(b);f.flush()
     if b'\x1b[6n' in b:os.write(master,b'\x1b[1;1R')
  threading.Thread(target=terminal_reader,daemon=True).start();pump(7)
  draft=prompt('human-draft');os.write(master,draft.encode());rec(event='synthetic_draft_typed_without_enter',text=draft);pump(2)
  enqueue('draft-notify');toolwait('draft-notify');settled();pump(2)
  assert not any(e['label']=='human-draft' for e in tools())
  os.write(master,b'\r');rec(event='synthetic_draft_explicitly_submitted')
  toolwait('human-draft');pump(2)
  native_texts=[]
  for e in received:
   i=e.get('params',{}).get('item',{})
   if i.get('type')=='userMessage':
    native_texts.extend(c.get('text','') for c in i.get('content',[]) if c.get('type')=='text')
  assert draft in native_texts, 'submitted user message must exactly equal pre-notify draft'
  result['cases']['draft']='PASS: owned TUI draft remained unsubmitted through native queue notification; explicit Enter submitted its exact original text'
  result['draftText']=draft;result['status']='PASS TUI draft'
 else:
  enqueue('idle');toolwait('idle');settled();result['cases']['idle']='PASS: CLI queue starts an idle loaded thread without explicit turn/start'
  turn('busy','probe_gate');toolwait('busy','tool_enter');enqueue('busy-notify');pump(2)
  pending=rpc('thread/queue/list',{'threadId':sid});assert len(pending['data'])==1
  assert not any(e['label']=='busy-notify' for e in tools());rec(event='busy_notification_pending',queueCount=len(pending['data']))
  (root/'release').touch();toolwait('busy-notify');settled();result['cases']['busy']='PASS: queued behind controlled in-flight MCP call, then processed'
  # Drain any earlier completion without interpreting it as an approval outcome.
  pump(1);before=len(received);turn('approval','probe_approval')
  approval=wait(lambda e:'id'in e and e.get('method')=='mcpServer/elicitation/request',40)
  rec(event='approval_requested',requestId=approval['id'],method=approval['method'])
  enqueue('approval-notify');pump(2)
  assert not any(e['label'] in ['approval','approval-notify'] for e in tools())
  pending=rpc('thread/queue/list',{'threadId':sid});assert len(pending['data'])==1
  rec(event='approval_unchanged_notification_pending',queueCount=1)
  send({'id':approval['id'],'result':{'action':'decline'}});rec(event='approval_explicitly_declined')
  toolwait('approval-notify');pump(1);result['cases']['approval']='PASS: notification neither grants approval nor executes queued work while approval is pending; explicit decline releases queue'
  result['cases']['draft']='not tested by headless RPC; separate TUI case required'
  result['status']='PASS protocol cases'
except Exception as e:result['status']='BLOCKED';result['error']=str(e)[:700];rec(event='blocked',reason=result['error'])
finally:
 result['events']=records;result['tools']=tools()
 # Retain structured event summaries only; native output/config remains private.
 result['nativeEvents']=[{'method':e.get('method'),'itemType':e.get('params',{}).get('item',{}).get('type'),'tool':e.get('params',{}).get('item',{}).get('tool')} for e in received if e.get('method') in ['turn/started','turn/completed','item/completed','mcpServer/elicitation/request']]
 out.write_text(json.dumps(result,indent=2)+'\n')
 for p in reversed(processes):
  if p.poll() is not None:continue
  try:os.killpg(p.pid,signal.SIGTERM)
  except (ProcessLookupError, PermissionError):
   if p.poll() is None:p.terminate()
  try:p.wait(timeout=4)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 print(json.dumps({'status':result['status'],'cases':result['cases']}),flush=True)

"""Claude ongoing stream-json input in idle/busy/host permission states."""
import json,os,pathlib,queue,signal,subprocess,sys,threading,time
here=pathlib.Path(__file__).resolve().parent;scratch=pathlib.Path(sys.argv[1]);assert scratch.name.startswith('byok-notify-probe-');root=scratch/'claude';root.mkdir(mode=0o700,exist_ok=True)
config={'mcpServers':{'notifyprobe':{'command':sys.executable,'args':[str(here/'notify-mcp.py'),str(root)]}}};(root/'mcp.json').write_text(json.dumps(config))
cmd=['claude','-p','--input-format','stream-json','--output-format','stream-json','--verbose','--replay-user-messages','--strict-mcp-config','--mcp-config',str(root/'mcp.json'),'--tools','','--allowedTools','mcp__notifyprobe__probe_gate,mcp__notifyprobe__probe_record','--permission-mode','manual','--permission-prompt-tool','stdio','--setting-sources','','--settings','{"disableAllHooks":true}','--no-session-persistence','--system-prompt','Perform the exact synthetic notifyprobe tool request and finish. Use only notifyprobe tools; never invent results.']
env=os.environ.copy();env.pop('CLAUDECODE',None);err=open(root/'stderr.private','w');os.chmod(err.name,0o600)
p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,cwd=root,env=env,text=True,start_new_session=True);q=queue.Queue();received=[];records=[]
def reader():
 with open(root/'stdout.private.jsonl','w') as f:
  os.chmod(f.name,0o600)
  for l in p.stdout:
   f.write(l);f.flush()
   try:q.put(json.loads(l))
   except ValueError:pass
threading.Thread(target=reader,daemon=True).start()
def rec(**e):records.append({'ts':time.time(),**e});print(json.dumps(e),flush=True)
def send(e):p.stdin.write(json.dumps(e)+'\n');p.stdin.flush()
def wait(pred,seconds=85):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  try:e=q.get(timeout=.1)
  except queue.Empty:
   if p.poll() is not None:raise RuntimeError('Claude exited '+str(p.returncode))
   continue
  received.append(e)
  if pred(e):return e
 raise TimeoutError('Claude native event deadline')
def pump(seconds):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  try:received.append(q.get(timeout=.1))
  except queue.Empty:pass
def tools():
 f=root/'tools.jsonl';return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []
def toolwait(label,event='tool_exit'):
 until=time.monotonic()+85
 while time.monotonic()<until:
  if any(e['label']==label and e['event']==event for e in tools()):return
  pump(.1)
  if any(e.get('type')=='result' and (e.get('is_error') or e.get('stop_reason')=='refusal') for e in received):raise RuntimeError('Claude provider returned an error/refusal; stop this lane without retry')
 raise TimeoutError('Claude tool event deadline '+label)
def notify(label,tool='probe_record'):
 send({'type':'user','message':{'role':'user','content':f'Call {tool} exactly once with label "{label}". Then finish with DONE.'}});rec(event='native_input_sent',label=label)
def settled():
 e=wait(lambda e:e.get('type')=='result');rec(event='result',sessionId=e.get('session_id'),subtype=e.get('subtype'));assert e.get('subtype')=='success' and not e.get('is_error') and e.get('stop_reason')!='refusal'
 return e
result={'harness':'claude','version':'2.1.261','scope':'print stream-json persistent process; not interactive TUI','cases':{}}
try:
 notify('idle');toolwait('idle');e=settled();result['sessionId']=e['session_id'];result['cases']['idle']='PASS: persistent stream-json accepts idle input'
 notify('busy','probe_gate');toolwait('busy','tool_enter');notify('busy-notify');pump(2);assert not any(e['label']=='busy-notify' for e in tools());rec(event='busy_notification_not_executed_before_release')
 (root/'release').touch();toolwait('busy-notify');settled();pump(2);result['cases']['busy']='PASS: second stream input waits while controlled tool call is in flight'
 notify('approval','probe_approval');approval=wait(lambda e:e.get('type')=='control_request' and e.get('request',{}).get('subtype')=='can_use_tool',40)
 rid=approval['request_id'];rec(event='approval_requested',requestId=rid,tool=approval['request'].get('tool_name'))
 notify('approval-notify');pump(2);assert not any(e['label'] in ['approval','approval-notify'] for e in tools());rec(event='approval_notification_did_not_execute')
 send({'type':'control_response','response':{'subtype':'success','request_id':rid,'response':{'behavior':'deny','message':'Synthetic probe explicitly declines this tool.'}}});rec(event='approval_explicitly_declined')
 toolwait('approval-notify');settled();result['cases']['approval']='PASS: further input did not grant or bypass pending SDK permission; explicit deny allowed continuation'
 result['cases']['draft']='UNVERIFIED: print protocol has no interactive editor; this test does not attach to a TUI'
 result['status']='PASS protocol cases'
except Exception as e:result['status']='BLOCKED';result['error']=str(e);rec(event='blocked',reason=str(e))
finally:
 pump(.2);result['events']=records;result['tools']=tools();result['resultSessionIds']=[e.get('session_id') for e in received if e.get('type')=='result'];result['providerResult']=[{k:e.get(k) for k in ['subtype','is_error','stop_reason','terminal_reason','session_id']} for e in received if e.get('type')=='result'];(here/('claude-notify-recheck-results.json' if '--recheck' in sys.argv else 'claude-notify-results.json')).write_text(json.dumps(result,indent=2)+'\n')
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 print(json.dumps({'status':result['status'],'cases':result['cases'],'error':result.get('error')}),flush=True)

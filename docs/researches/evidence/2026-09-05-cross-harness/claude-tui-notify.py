"""Owned Claude TUI hidden UDS probe; native child sends, tokens never leave it."""
import json,os,pathlib,pty,fcntl,termios,struct,subprocess,sys,threading,time,signal,uuid
here=pathlib.Path(__file__).resolve().parent;scratch=pathlib.Path(sys.argv[1]);assert scratch.name.startswith('byok-notify-probe-');root=scratch/'claude';root.mkdir(mode=0o700,exist_ok=True)
sid=str(uuid.uuid4());result={'harness':'claude','version':'2.1.261','sessionId':sid,'scope':'owned interactive TUI; hidden messaging-socket-path; actual MCP child auth','cases':{}}
config={'mcpServers':{'notifyprobe':{'command':sys.executable,'args':[str(here/'notify-mcp.py'),str(root),'--uds-notify']}}};(root/'tui-mcp.json').write_text(json.dumps(config))
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0));env=os.environ.copy();env.pop('CLAUDECODE',None);env['TERM']='xterm-256color'
prompt=lambda label:f'Call probe_record exactly once with label "{label}". Then finish with DONE.'
cmd=['claude','--bare','--session-id',sid,'--messaging-socket-path',str(root/'inbox.sock'),'--strict-mcp-config','--mcp-config',str(root/'tui-mcp.json'),'--tools','','--allowedTools','mcp__notifyprobe__probe_record,mcp__notifyprobe__probe_gate','--permission-mode','manual','--setting-sources','','--settings','{"disableAllHooks":true}','--system-prompt','Perform exact synthetic notifyprobe instructions. Use only those tools. Do not invent results.',prompt('idle')]
startup_only='--startup-only' in sys.argv
if startup_only:cmd=cmd[:-1]
p=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,cwd=root,env=env,start_new_session=True);os.close(slave)
def reader():
 with open(root/'tui.private.bin','wb') as f:
  os.chmod(f.name,0o600)
  while True:
   try:b=os.read(master,65536)
   except OSError:return
   if not b:return
   f.write(b);f.flush()
   if b'\x1b[6n'in b:os.write(master,b'\x1b[1;1R')
threading.Thread(target=reader,daemon=True).start()
def events():
 f=root/'tools.jsonl';return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []
def wait(pred,start=0,seconds=65):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  consent=root/'trust-owned-directory'
  if consent.exists():
   consent.unlink();os.write(master,b'\x1b[B\r');result['ownedDirectoryTrustSelected']=True
  for e in events()[start:]:
   if pred(e):return e
  if p.poll() is not None:raise RuntimeError('Claude TUI exited '+str(p.returncode))
  time.sleep(.1)
 raise TimeoutError('Claude TUI event deadline')
def transcript():
 files=list((pathlib.Path.home()/'.claude/projects').glob('*/'+sid+'.jsonl'))
 return [json.loads(l) for f in files for l in f.read_text().splitlines()]
def send_notify(label):
 v={'id':str(uuid.uuid4()),'label':label,'text':prompt(label)};t=root/'uds-request.tmp';t.write_text(json.dumps(v));t.replace(root/'uds-request.json')
start=len(events())
try:
 ready=wait(lambda e:e['event']=='uds_child_ready',start,seconds=55);result['nativeChildCapability']=ready
 assert ready['socketAvailable'],'native MCP child did not receive socket'
 if startup_only:
  result['status']='PASS startup only; no model input or notification'
  result['cases']['startup']='Native MCP child received socket metadata after explicit trust of owned scratch directory'
 else:
  wait(lambda e:e['event']=='tool_exit' and e.get('label')=='idle',start);time.sleep(3)
  draft=prompt('human-draft');os.write(master,draft.encode());result['draftText']=draft;time.sleep(1)
  send_notify('draft-notify');wait(lambda e:e['event']=='tool_exit' and e.get('label')=='draft-notify',start);time.sleep(3)
  assert not any(e['event']=='tool_enter' and e.get('label')=='human-draft' for e in events()[start:])
  os.write(master,b'\r');wait(lambda e:e['event']=='tool_exit' and e.get('label')=='human-draft',start);time.sleep(2)
  found=[e.get('message',{}).get('content') for e in transcript() if e.get('type')=='user']
  assert draft in found,'native transcript must contain exact submitted draft'
  result['cases']['idle']='PASS: native child UDS user frame wakes owned TUI'
  result['cases']['draft']='PASS: draft not submitted by UDS notify; explicit Enter submits exact original transcript text'
  result['status']='PASS hidden TUI route; not a public compatibility contract'
except Exception as e:result['status']='BLOCKED';result['error']=str(e)
finally:
 result['events']=events()[start:];(here/('claude-tui-startup-results.json' if startup_only else 'claude-tui-notify-results.json')).write_text(json.dumps(result,indent=2)+'\n')
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 print(json.dumps({'status':result['status'],'cases':result['cases'],'error':result.get('error')}),flush=True)

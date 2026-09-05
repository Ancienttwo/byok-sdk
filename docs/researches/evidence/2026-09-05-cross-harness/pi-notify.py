"""Real Pi TUI + extension API notifications; editor/modal evidence is structured."""
import json,os,pathlib,pty,fcntl,termios,struct,subprocess,sys,threading,time,signal
here=pathlib.Path(__file__).resolve().parent;repo=here.parents[3];scratch=pathlib.Path(sys.argv[1]);assert scratch.name.startswith('byok-notify-probe-')
root=scratch/'pi';root.mkdir(mode=0o700,exist_ok=True);master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
env=os.environ.copy();env['TERM']='xterm-256color';env['BYOK_NOTIFY_PROBE_ROOT']=str(root)
cmd=[str(repo/'packages/client/node_modules/.bin/pi'),'--session-dir',str(root/'sessions'),'--no-extensions','--no-context-files','--no-skills','--no-prompt-templates','--no-themes','--no-builtin-tools','--extension',str(here/'pi-notify-extension.ts'),'--provider','zai','--model','glm-5.3']
p=subprocess.Popen(cmd,stdin=slave,stdout=slave,stderr=slave,cwd=root,env=env,start_new_session=True);os.close(slave)
def terminal():
 with open(root/'tui.private.bin','wb') as f:
  os.chmod(f.name,0o600)
  while True:
   try:b=os.read(master,65536)
   except OSError:return
   if not b:return
   f.write(b);f.flush()
   if b'\x1b[6n' in b:os.write(master,b'\x1b[1;1R')
threading.Thread(target=terminal,daemon=True).start()
def events():
 f=root/'events.jsonl';return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []
def wait(pred,start=0,seconds=90):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  for e in events()[start:]:
   if pred(e):return e
  if p.poll() is not None:raise RuntimeError('Pi exited '+str(p.returncode))
  time.sleep(.1)
 raise TimeoutError('Pi event deadline')
i=0
def request(op,**kw):
 global i
 i+=1;v={'id':str(i),'op':op,**kw};t=root/'request.tmp';t.write_text(json.dumps(v));t.replace(root/'request.json');return wait(lambda e:e.get('id')==str(i),seconds=10)
def notify(label,tool='probe_record'):return request('notify',label=label,tool=tool)
def tool(label,event='tool_exit'):return wait(lambda e:e.get('event')==event and e.get('label')==label)
def settle(start):return wait(lambda e:e['event']=='agent_settled',start)
result={'harness':'pi','version':'0.84.2','scope':'actual package-local interactive TUI; explicit disposable extension','cases':{}}
try:
 ready=wait(lambda e:e['event']=='ready',seconds=35);result['sessionId']=ready['sessionId']
 request('draft');begin=len(events());notify('idle');tool('idle');settle(begin)
 snap=request('snapshot');assert snap['editor']=='HUMAN_DRAFT_SENTINEL'
 result['cases']['idle']='PASS: sendUserMessage starts idle TUI turn';result['cases']['draft']='PASS: getEditorText preserves exact synthetic draft across notify and completed turn';print('Pi idle/draft PASS',flush=True)
 begin=len(events());notify('busy','probe_gate');tool('busy','tool_enter');notify('busy-notify');time.sleep(2)
 snap=request('snapshot');assert not snap['idle'];assert not any(e.get('label')=='busy-notify' and e['event']=='tool_enter' for e in events())
 request('release');tool('busy-notify');settle(begin);result['cases']['busy']='PASS: followUp waits behind controlled tool call';print('Pi busy PASS',flush=True)
 begin=len(events());notify('approval','probe_approval');wait(lambda e:e['event']=='confirm_open' and e.get('label')=='approval');notify('approval-notify');time.sleep(2)
 snap=request('snapshot');assert snap['pendingConfirm'] and not snap['idle'];assert not any(e.get('label')=='approval-notify' and e['event']=='tool_enter' for e in events())
 os.write(master,b'\x1b');denied=wait(lambda e:e['event']=='confirm_resolved' and e.get('label')=='approval');assert denied['answer'] is False
 tool('approval-notify');settle(begin);result['cases']['toolApproval']='PASS: followUp does not resolve in-flight extension approval; explicit Escape declines, then queued turn runs';print('Pi tool approval PASS',flush=True)
 begin=len(events());request('confirm');opened=wait(lambda e:e['event']=='confirm_open' and e.get('label')=='idle-dialog');assert opened['idle']
 notify('idle-dialog-notify');ran=tool('idle-dialog-notify');assert ran['pendingConfirm'];settle(begin)
 result['cases']['idleDialog']='OBSERVED: a UI confirm while agent idle does not gate sendUserMessage; notified model turn runs while dialog remains unresolved'
 os.write(master,b'\x1b');wait(lambda e:e['event']=='confirm_resolved' and e.get('label')=='idle-dialog')
 snap=request('snapshot');assert snap['editor']=='HUMAN_DRAFT_SENTINEL';result['status']='COMPLETED with idle-dialog boundary'
except Exception as e:result['status']='BLOCKED';result['error']=str(e)
finally:
 result['events']=events();(here/'pi-notify-results.json').write_text(json.dumps(result,indent=2)+'\n')
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 print(json.dumps({'status':result['status'],'cases':result['cases'],'error':result.get('error')}),flush=True)

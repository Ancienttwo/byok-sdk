"""Synthetic-only native notification probe tools. No product message authority."""
import json,pathlib,sys,threading,time,os,socket
root=pathlib.Path(sys.argv[1]);assert root.name in ['codex','claude'] and root.parent.name.startswith('byok-notify-probe-')
lock=threading.Lock()
def event(x):
 with lock:
  with open(root/'tools.jsonl','a') as f:f.write(json.dumps({'ts':time.time(),**x})+'\n')
def reply(i,r):
 with lock:print(json.dumps({'jsonrpc':'2.0','id':i,'result':r}),flush=True)
def call(e):
 p=e['params'];name=p['name'];label=p.get('arguments',{}).get('label','')
 if label not in ['idle','busy','busy-notify','approval','approval-notify','draft-notify','human-draft']:raise ValueError('invalid synthetic label')
 event({'event':'tool_enter','tool':name,'label':label})
 if name=='probe_gate':
  until=time.monotonic()+90
  while not (root/'release').exists() and time.monotonic()<until:time.sleep(.05)
  if not (root/'release').exists():reply(e['id'],{'content':[{'type':'text','text':'gate deadline'}],'isError':True});return
 event({'event':'tool_exit','tool':name,'label':label});reply(e['id'],{'content':[{'type':'text','text':'Recorded '+label}]})
# Only the optional TUI probe enables this actual harness-child sender.
if '--uds-notify' in sys.argv:
 def sender():
  last='';endpoint=os.environ.get('CLAUDE_CODE_MESSAGING_SOCKET');token=os.environ.get('CLAUDE_CODE_MESSAGING_TOKEN')
  event({'event':'uds_child_ready','socketAvailable':bool(endpoint),'tokenAvailable':bool(token)})
  while True:
   request=root/'uds-request.json'
   if request.exists():
    r=json.loads(request.read_text())
    if r['id']!=last:
     last=r['id']
     try:
      if not endpoint:raise RuntimeError('native messaging socket not supplied to MCP child')
      with socket.socket(socket.AF_UNIX) as sock:
       sock.settimeout(3);sock.connect(endpoint)
       if token:sock.sendall((json.dumps({'type':'auth','token':token})+'\n').encode())
       sock.sendall((json.dumps({'type':'user','message':{'role':'user','content':r['text']},'priority':'next'})+'\n').encode())
       # Receipt is only a socket-write observation; tool execution is the delivery oracle.
      event({'event':'uds_sent','label':r['label']})
     except Exception as e:event({'event':'uds_error','error':str(e)[:200]})
   time.sleep(.05)
 threading.Thread(target=sender,daemon=True).start()
for l in sys.stdin:
 e=json.loads(l);m=e.get('method');i=e.get('id')
 if m=='initialize':reply(i,{'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'synthetic-notify-probe','version':'1'}})
 elif m=='tools/list':reply(i,{'tools':[{'name':n,'description':'Synthetic probe only. Record the exact label.'+(' Wait at the externally controlled gate.' if n=='probe_gate' else ''),'inputSchema':{'type':'object','properties':{'label':{'type':'string'}},'required':['label'],'additionalProperties':False}} for n in ['probe_gate','probe_approval','probe_record']]})
 elif m=='tools/call':threading.Thread(target=call,args=(e,),daemon=True).start()
 elif i is not None:reply(i,{})

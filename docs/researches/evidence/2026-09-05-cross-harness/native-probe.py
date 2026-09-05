"""Bounded disposable native protocol probe; raw output stays private in scratch."""
import json, os, pathlib, queue, signal, subprocess, sys, threading, time
ROOT=pathlib.Path(__file__).resolve().parents[4]
SCR=pathlib.Path(sys.argv[1]); lane=sys.argv[2]
assert str(SCR).startswith('/tmp/byok-harness-probe-')
FIX=pathlib.Path(__file__).with_name('team-fixture.ts').resolve()
env=os.environ.copy(); env.pop('CLAUDECODE',None)
config=json.loads((SCR/lane/'mcp.json').read_text())
if lane=='claude':
 cmd=['claude','-p','--input-format','stream-json','--output-format','stream-json','--verbose','--strict-mcp-config','--mcp-config',str(SCR/lane/'mcp.json'),'--tools','','--allowedTools','mcp__byokagentteam__post_team_message,mcp__byokagentteam__read_team_messages,mcp__byokagentteam__ack_team_messages','--permission-mode','dontAsk','--setting-sources','','--settings','{"disableAllHooks":true}','--no-session-persistence']
elif lane=='pi':
 config['settings']={'hostConfigDiscovery':'off','scriptMode':False,'disableProxyTool':True}
 config['mcpServers']['byokagentteam'].update(lifecycle='eager',directTools=True,toolPrefix='none',includeTools=['post_team_message','read_team_messages','ack_team_messages'],exposeResources=False)
 (SCR/lane/'probe-mcp.json').write_text(json.dumps(config)); env['BYOK_PI_MCP_CONFIG_PATH']=str(SCR/lane/'probe-mcp.json')
 cmd=[str(ROOT/'packages/client/node_modules/.bin/pi'),'--mode','rpc','--session-dir',str(SCR/lane/'sessions'),'--no-extensions','--no-context-files','--no-skills','--no-prompt-templates','--no-themes','--no-builtin-tools','--exclude-tools','mcp,mcpScript','--extension',str(ROOT/'packages/client/src/adapters/pi/mcp-extension.ts'),'--provider','zai','--model','glm-5.3']
else:
 import tomllib
 ambient=tomllib.loads((pathlib.Path.home()/'.codex/config.toml').read_text())
 cmd=['codex','app-server']
 for name in ambient.get('mcp_servers',{}): cmd+=['-c',f'mcp_servers.{name}.enabled=false']
 for key,value in config['mcpServers']['byokagentteam'].items(): cmd+=['-c',f'mcp_servers.byokagentteam.{key}='+json.dumps(value)]
 cmd+=['-c','mcp_servers.byokagentteam.enabled=true','-c','features.shell_tool=false','-c','features.multi_agent=false','-c','features.apps=false','-c','project_doc_max_bytes=0']
 for name in ['post_team_message','read_team_messages','ack_team_messages']: cmd+=['-c',f'mcp_servers.byokagentteam.tools.{name}.approval_mode="approve"']
q=queue.Queue(); events=[]; result={'lane':lane,'startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'rounds':[]}
p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,cwd=SCR/lane,env=env,start_new_session=True)
def reader(stream,tag):
 with open(SCR/lane/(tag+'.private.jsonl'),'w') as log:
  os.chmod(log.name,0o600)
  for line in stream:
   log.write(line); log.flush()
   if tag=='stdout':
    try:q.put(json.loads(line))
    except ValueError: pass
threading.Thread(target=reader,args=(p.stdout,'stdout'),daemon=True).start(); threading.Thread(target=reader,args=(p.stderr,'stderr'),daemon=True).start()
def send(x):p.stdin.write(json.dumps(x)+'\n');p.stdin.flush()
def wait(pred,seconds=100):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  try:e=q.get(timeout=.25)
  except queue.Empty:
   if p.poll() is not None: raise RuntimeError('process exited '+str(p.returncode))
   continue
  events.append(e)
  if pred(e):return e
 raise TimeoutError('native event deadline exceeded')
def rpc(i,m,params):
 send({'id':i,'method':m,'params':params});r=wait(lambda e:e.get('id')==i,30)
 if 'error'in r:raise RuntimeError(str(r['error']))
 return r['result']
try:
 if lane=='codex':
  rpc(1,'initialize',{'clientInfo':{'name':'byok_team_probe','version':'1'}});send({'method':'initialized'})
  t=rpc(2,'thread/start',{'cwd':str(SCR/lane),'ephemeral':True,'approvalPolicy':'never','baseInstructions':'Perform the exact synthetic team MCP probe. Use only byokagentteam tools. Do not inspect files or use other tools.'})
  sid=t['thread']['id'];result['sessionId']=sid
 if lane=='pi':
  send({'id':'s0','type':'get_state'});e=wait(lambda e:e.get('id')=='s0',35);result['sessionId']=e.get('data',{}).get('sessionId')
 for n in [1,2]:
  body=f'challenge-{lane}-{n}'
  subprocess.run(['bun',str(FIX),'seed',str(SCR),'operator',body],check=True,capture_output=True,text=True,timeout=10)
  prompt=f'Probe round {n}. Call read_team_messages with afterSeq 0. Find exact body {body}. Then call post_team_message with body "reply-{lane}-{n}". Then call read_team_messages with afterSeq 0 again, and ack_team_messages with throughSeq equal to that result deliveredThroughSeq. Use only these three team tools. Stop after successful ack; final text DONE. Do not invent results.'
  if lane=='claude':send({'type':'user','message':{'role':'user','content':prompt}});end=wait(lambda e:e.get('type')=='result');sid=end.get('session_id');result.setdefault('sessionId',sid)
  elif lane=='pi':send({'id':f'p{n}','type':'prompt','message':prompt});end=wait(lambda e:e.get('type')=='agent_settled');send({'id':f's{n}','type':'get_state'});s=wait(lambda e:e.get('id')==f's{n}',10);sid=s.get('data',{}).get('sessionId')
  else:rpc(10+n,'turn/start',{'threadId':sid,'input':[{'type':'text','text':prompt}],'effort':'low'});end=wait(lambda e:e.get('method')=='turn/completed')
  result['rounds'].append({'round':n,'sessionId':sid,'completion':end.get('subtype',end.get('type',end.get('method')))})
  print(json.dumps({'lane':lane,'round':n,'complete':True}),flush=True)
 result['status']='protocol-completed'
except Exception as e:result['status']='blocked';result['error']=str(e)[:500]
finally:
 try:os.killpg(p.pid,signal.SIGTERM)
 except ProcessLookupError:pass
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 result['exitCode']=p.returncode
 (SCR/lane/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)

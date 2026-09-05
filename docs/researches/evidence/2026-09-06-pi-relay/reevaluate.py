"""Re-evaluate the original frozen native run without any process/provider calls.
The original runner incorrectly demanded Bob ack his own seq 2. Receipt authority
is the sequence actually returned to that member by read_team_messages.
"""
import json,hashlib,pathlib
HERE=pathlib.Path(__file__).resolve().parent
REPO=HERE.parents[3]
r=json.loads((HERE/'initial-oracle-results.json').read_text())
w=json.loads((HERE/'same-run-workspace.json').read_text())
assert r['status']=='FAIL' and r['errorType']=='TimeoutError'
assert r['confirmationBeforeResponse']=='PASS' and r['ownedProcessesStopped']
for p,h in r['sourceSha256'].items():assert hashlib.sha256((REPO/p).read_bytes()).hexdigest()==h,p
assert hashlib.sha256((REPO/'packages/client/dist/bin/byok-agent.js').read_bytes()).hexdigest()==r['builtCliSha256']
for p,h in r['builtArtifactsSha256'].items():assert hashlib.sha256((REPO/p).read_bytes()).hexdigest()==h,p
assert [(m['seq'],m['senderMemberId']) for m in w['messages']]==[(1,'alice'),(2,'bob')]
assert w['receipts']=={'alice':{'deliveredThroughSeq':2,'acknowledgedThroughSeq':2},'bob':{'deliveredThroughSeq':1,'acknowledgedThroughSeq':1}}
assert w['nativeCleanup']['sameRun'] and w['nativeCleanup']['nativeThreadsDeleted']
assert w['nativeCleanup']['turnStatuses']==['completed','completed'] and w['relayStderrEmpty']
e=r['ledger'];attempts=[v for v in e if v.get('event')=='queue_attempt'];accepted=[v for v in e if v.get('event')=='queue_accepted']
assert [(v['harness'],v['throughSeq']) for v in attempts]==[('pi',1),('codex',2)]
assert [(v['harness'],v['throughSeq']) for v in accepted]==[('pi',1),('codex',2)]
assert next(i for i,v in enumerate(e) if v.get('event')=='ui_request') < next(i for i,v in enumerate(e) if v.get('event')=='ui_response_sent') < next(i for i,v in enumerate(e) if v.get('event')=='queue_attempt')
assert any(v.get('state')=='budget_exhausted' and v.get('attempts')==2 for v in e)
assert any(v.get('event')=='pi_settled' for v in e)
assert not any(v.get('event') in ['invalid_json_output','pi_failed','command_rejected'] for v in e)
for member in ['alice','bob']:
 ack=next(v for v in r['controlEvents'] if v['method']=='ack' and v['member']==member)
 reads=[v for v in r['controlEvents'] if v['method']=='read' and v['member']==member and v['ts']<ack['ts']]
 assert reads and ack['throughSeq']==reads[-1]['deliveredThroughSeq']
r.update(status='PASS',scratchRemoved=w.get('scratchRemoved',False),messages=w['messages'],receipts=w['receipts'],nativeThreadsDeleted=True,nativeCompletedTurns={'alice':2},relayStderrEmpty=True)
r['evaluation']={'mode':'same-native-run-corrected-oracle','originalResult':'initial-oracle-results.json','workspaceProjection':'same-run-workspace.json','reason':'Bob must ack delivered sequence 1, not his own reply sequence 2','additionalProviderCalls':0,'relayExitCode':'not captured on the initial timeout assertion path; settlement, receipts, empty stderr and owned-process cleanup are recorded'}
for k in ['error','errorType','privateScratch']:r.pop(k,None)
(HERE/'results.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({'status':r['status'],'additionalProviderCalls':0}))

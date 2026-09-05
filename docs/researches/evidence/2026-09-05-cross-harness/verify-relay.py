"""Offline verifier for the recorded two-Codex relay epoch; no provider calls."""
import hashlib,json,pathlib,uuid
HERE=pathlib.Path(__file__).resolve().parent
r=json.loads((HERE/'relay-smoke-results.json').read_text())
assert r['status']=='PASS' and r['pauseBeforeResume']=='PASS'
assert r['nativeThreadsDeleted'] and r['ownedProcessesStopped'] and r['scratchRemoved']
sessions={s['member']:s['threadId'] for s in r['sessions']};assert len(set(sessions.values()))==2
messages={m['seq']:m for m in r['messages']};assert list(messages)==[1,2]
ledger=r['ledger'];attempts=[e for e in ledger if e.get('event')=='queue_attempt'];accepted=[e for e in ledger if e.get('event')=='queue_accepted']
assert len(attempts)==len(accepted)==2
for i,(a,b) in enumerate(zip(attempts,accepted),1):
 assert a['attempt']==b['attempt']==i
 assert a['threadId']==sessions[a['memberId']]==b['threadId']
 assert a['latestPeerSeq']>a['watermark'] and a['latestPeerSeq']==b['latestPeerSeq']
 assert messages[a['latestPeerSeq']]['senderMemberId']!=a['memberId']
 uuid.UUID(b['queueId'])
assert ledger[-1]['state']=='budget_exhausted' and ledger[-1]['attempts']==ledger[-1]['maxNotifications']==2
paused=False
for e in ledger:
 if e.get('state')=='paused':paused=True
 elif e.get('state')=='running':paused=False
 if e.get('event')=='queue_attempt':assert not paused
for member in sessions:
 delivered=0;acked=0
 for e in r['controlEvents']:
  if e['member']!=member:continue
  if e['method']=='read':delivered=max(delivered,e['deliveredThroughSeq'])
  if e['method']=='ack':assert acked<=e['throughSeq']<=delivered;acked=e['throughSeq']
 assert acked==r['receipts'][member]['acknowledgedThroughSeq']==2
 assert acked>=max(m['seq'] for m in messages.values() if m['senderMemberId']!=member)
for relative,digest in r['sourceSha256'].items():
 assert hashlib.sha256((HERE.parents[3]/relative).read_bytes()).hexdigest()==digest, 'source changed: '+relative
print('PASS: exact targets, peer-only notifications, read-before-ack, pause, finite budget, cleanup, source fingerprints')

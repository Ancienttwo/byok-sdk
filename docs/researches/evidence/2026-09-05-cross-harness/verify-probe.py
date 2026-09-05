"""Verify native completion against real durable synthetic messages and control receipts."""
import json,pathlib,subprocess,sys
scratch=pathlib.Path(sys.argv[1]);out=pathlib.Path(__file__).resolve().parent
fixture=out/'team-fixture.ts'
messages=json.loads(subprocess.check_output(['bun',str(fixture),'inspect',str(scratch),'operator'],text=True))
events=[json.loads(s) for s in (scratch/'control-events.jsonl').read_text().splitlines()]
results=[]
for lane in ['claude','codex','pi']:
 r=json.loads((scratch/lane/'result.json').read_text())
 assert r['status']=='protocol-completed',r
 assert len(r['rounds'])==2 and r['sessionId'] and all(x['sessionId']==r['sessionId'] for x in r['rounds'])
 receipts=[e for e in events if e['member']==lane]
 assert sum(e['method']=='read' for e in receipts)==4
 assert sum(e['method']=='ack' for e in receipts)==2
 for n in [1,2]:
  found=[m for m in messages if m['senderMemberId']==lane and m['body']==f'reply-{lane}-{n}']
  assert len(found)==1
  assert any(e['method']=='ack' and e['throughSeq']>=found[0]['seq'] for e in receipts)
 r['assertions']='same-session; 2 exact durable replies; 4 reads; 2 covering acknowledgements'
 results.append(r)
assert len(messages)==12
(out/'results.json').write_text(json.dumps({'scope':'macOS native protocol idle continuation; actual SDK store/control/helper; no TUI or automatic wakeup acceptance','results':results,'messages':messages,'controlEvents':events},indent=2)+'\n')
print('PASS: 3 native sessions, 6 durable replies, 12 reads, 6 acknowledgements; synthetic evidence exported')

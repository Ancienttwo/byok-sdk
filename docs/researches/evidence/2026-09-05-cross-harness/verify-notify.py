"""Offline verification of exported native notification observations and boundaries."""
import json,pathlib
here=pathlib.Path(__file__).resolve().parent
load=lambda name:json.loads((here/name).read_text())
c=load('codex-notify-results.json');d=load('codex-draft-results.json');p=load('pi-notify-results.json');a=load('claude-notify-results.json');t=load('claude-tui-notify-results.json')
assert c['status']=='PASS protocol cases' and all(c['cases'][k].startswith('PASS') for k in ['idle','busy','approval'])
ce=c['events'];ct=c['tools']
def cevent(kind):return next(e for e in ce if e['event']==kind)
def ctool(label,event):return next(e for e in ct if e.get('label')==label and e['event']==event)
assert ctool('busy','tool_exit')['ts']<ctool('busy-notify','tool_enter')['ts']
assert cevent('approval_unchanged_notification_pending')['ts']<cevent('approval_explicitly_declined')['ts']<ctool('approval-notify','tool_enter')['ts']
assert not any(e.get('label')=='approval' for e in ct)
assert d['status']=='PASS TUI draft'
assert any(x.get('text')==d['draftText'] for m in d['nativeUserMessages'] for x in m['content'])
assert p['status']=='COMPLETED with idle-dialog boundary';pe=p['events']
assert all(e['sessionId']==p['sessionId'] for e in pe)
assert all(e.get('editor','HUMAN_DRAFT_SENTINEL')=='HUMAN_DRAFT_SENTINEL' for e in pe if e['event']!='ready')
def pi_event(kind,label):return next(e for e in pe if e['event']==kind and e.get('label')==label)
assert pi_event('tool_exit','busy')['ts']<pi_event('tool_enter','busy-notify')['ts']
assert pi_event('confirm_resolved','approval')['answer'] is False
assert pi_event('confirm_resolved','approval')['ts']<pi_event('tool_enter','approval-notify')['ts']
assert pi_event('tool_enter','idle-dialog-notify')['pendingConfirm'] is True
assert pi_event('confirm_open','idle-dialog')['idle'] is True
assert pi_event('tool_enter','idle-dialog-notify')['ts']<pi_event('confirm_resolved','idle-dialog')['ts']
assert a['status']=='BLOCKED'
assert any(e['subtype']=='success' and e['is_error'] is True and e['stop_reason']=='refusal' and e['terminal_reason']=='api_error' for e in a['providerResult'])
assert t['status']=='BLOCKED' and not any(e['event']=='uds_sent' for e in t['events'])
print('PASS evidence consistency: Codex queue+draft; Pi followUp+draft+modal counterexample; Claude provider refusal and unverified TUI preserved')

recheck=load('claude-notify-recheck-results.json');startup=load('claude-tui-startup-results.json')
assert recheck['status']=='BLOCKED'
assert any(e['category']=='reasoning_extraction' for e in recheck['providerRefusals'])
assert any(e['is_error'] and e['stop_reason']=='refusal' for e in recheck['providerResult'])
assert not any(e.get('label')=='busy' for e in recheck['tools'])
assert startup['status']=='PASS startup only; no model input or notification'
assert startup['ownedDirectoryTrustSelected'] is True
assert startup['nativeChildCapability']['socketAvailable'] and startup['nativeChildCapability']['tokenAvailable']
assert all(e['event']=='uds_child_ready' for e in startup['events'])
print('PASS Claude continuation evidence: repeat provider refusal; no-model native startup only')

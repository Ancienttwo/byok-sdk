from pathlib import Path
import os,subprocess,json,time
out=Path('/Users/kito/Projects/byok-sdk-wt-doctor-repair/_ops/doctor-classification')
env=dict(os.environ);env['PATH']='/Users/kito/.npm/_npx/ca3942424f2c6fc5/node_modules/node/bin:'+env['PATH']
files=['src/__tests__/agent-egress-spool.test.ts','src/__tests__/agent-message-outbox.test.ts','src/__tests__/durable-egress-faults.test.ts','src/__tests__/agent-home-projection.test.ts']
pattern='reopens after natural compaction retaining (1|3) records|reopens after natural compaction retaining 0 drafts|outbox: natural compaction propagates (temp|target|directory) sync failure|keeps the mailbox cursor behind exact completion'
results=[]
for label,root in [('base','/Users/kito/Projects/byok-sdk-wt-doctor-baseline'),('candidate','/Users/kito/Projects/byok-sdk-wt-doctor-repair')]:
    command=['bun','run','--cwd','packages/client','test','--',*files,'-t',pattern,'--reporter=json','--outputFile='+str(out/(label+'-seven.json'))]
    started=time.time()
    with (out/(label+'-seven.log')).open('w') as log:
        try:
            r=subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=150)
            rc=r.returncode
        except subprocess.TimeoutExpired:rc=124
    row={'label':label,'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'command':command,'exit':rc,'seconds':time.time()-started}
    if (out/(label+'-seven.json')).exists():
        data=json.loads((out/(label+'-seven.json')).read_text())
        row['tests']=[{'name':a['fullName'],'status':a['status'],'durationMs':a.get('duration'),'failureMessages':a.get('failureMessages',[])} for f in data['testResults'] for a in f['assertionResults'] if a['status']!='pending']
    results.append(row)
    (out/'paired-results.json').write_text(json.dumps(results,indent=2)+'\n')
    print(label,rc,round(row['seconds'],2),[(x['name'],x['status'],x['durationMs']) for x in row.get('tests',[])],flush=True)

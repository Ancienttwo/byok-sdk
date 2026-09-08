from pathlib import Path
import subprocess,os,json,time,hashlib
candidate=Path('/Users/kito/Projects/byok-sdk-wt-doctor-repair')
out=candidate/'_ops/doctor-classification'
env=dict(os.environ);env['PATH']='/Users/kito/.npm/_npx/ca3942424f2c6fc5/node_modules/node/bin:'+env['PATH']
setup='''import { promises as fs, appendFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, vi } from 'vitest';
const nativeOpen = fs.open.bind(fs);
let syncCalls = 0;
let addedDelayMs = 0;
let realSyncMs = 0;
beforeEach(() => {
  syncCalls = 0; addedDelayMs = 0; realSyncMs = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (String(args[0]).endsWith('.jsonl')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        syncCalls++;
        const waitStart = performance.now();
        await new Promise(resolve => setTimeout(resolve, 21));
        addedDelayMs += performance.now() - waitStart;
        const ioStart = performance.now();
        try { return await sync(); } finally { realSyncMs += performance.now() - ioStart; }
      };
    }
    return handle;
  });
});
afterEach(() => {
  appendFileSync(process.env.DOCTOR_PROFILE_OUTPUT!, JSON.stringify({test: expect.getState().currentTestName, syncCalls, addedDelayMs, realSyncMs}) + '\\n');
});
'''
config="import config from '../../packages/client/vitest.config';\nexport default { ...config, test: { ...config.test, setupFiles: [new URL('./sync-delay.setup.ts', import.meta.url).pathname], testTimeout: 60000 } };\n"
projection_rel=Path('packages/client/src/__tests__/doctor-projection-observer.test.ts')
source=(candidate/'packages/client/src/__tests__/agent-home-projection.test.ts').read_text()
needle='    await vi.waitFor(() => expect(rejectedCompletions).toBeGreaterThan(0));'
assert source.count(needle)==1
probe=source.replace(needle,needle+'''\n    // Observer-only probe: allow a second legitimate redelivery before stopping A.
    await vi.waitFor(() => expect(rejectedCompletions).toBeGreaterThanOrEqual(2));''')
needle2='    expect(hookCwds).toHaveLength(2);'
assert probe.count(needle2)==1
probe=probe.replace(needle2,'''    console.log('DOCTOR_PROJECTION_OBSERVATION', JSON.stringify({ rejectedCompletions, hookCount: hookCwds.length, cursor: await new CursorStore(storeDir).load(real.url, record.deviceId), status: (await real.byok.readAgentHomeProjection(record.deviceId, desired('1').agentRef, desired('1').requestId))?.status, runtimeSessions: adapterA.sessions.length + adapterB.sessions.length }));
'''+needle2)
(out/'projection-observer-source.ts').write_text(probe)
(out/'sync-delay.setup.ts').write_text(setup)
(out/'sync-delay.vitest.config.ts').write_text(config)
results=[]
for label,root in [('base',Path('/Users/kito/Projects/byok-sdk-wt-doctor-baseline')),('candidate',candidate)]:
    local=root/'_ops/doctor-classification';local.mkdir(parents=True,exist_ok=True)
    (local/'sync-delay.setup.ts').write_text(setup)
    (local/'sync-delay.vitest.config.ts').write_text(config)
    for kind in ['projection']:
        if kind=='projection':
            assert not (root/projection_rel).exists()
            (root/projection_rel).write_text(probe)
            extra=['src/__tests__/doctor-projection-observer.test.ts','-t','keeps the mailbox cursor behind exact completion']
        else:
            extra=['src/__tests__/agent-egress-spool.test.ts','src/__tests__/agent-message-outbox.test.ts','src/__tests__/durable-egress-faults.test.ts','-t','reopens after natural compaction retaining (1|3) records|reopens after natural compaction retaining 0 drafts|outbox: natural compaction propagates (temp|target|directory) sync failure','--config',str(local/'sync-delay.vitest.config.ts')]
        report=out/(label+'-'+kind+'.json')
        command=['bun','run','--cwd','packages/client','test','--',*extra,'--reporter=json','--outputFile='+str(report)]
        env['DOCTOR_PROFILE_OUTPUT']=str(out/(label+'-sync-observations.jsonl'))
        started=time.time()
        try:
            with (out/(label+'-'+kind+'.log')).open('w') as log:
                try: rc=subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180).returncode
                except subprocess.TimeoutExpired:rc=124
        finally:
            if kind=='projection':(root/projection_rel).unlink()
        row={'label':label,'kind':kind,'exit':rc,'seconds':time.time()-started,'command':command}
        if report.exists():
            data=json.loads(report.read_text());row['tests']=[{'name':a['fullName'],'status':a['status'],'durationMs':a.get('duration'),'failureMessages':a.get('failureMessages',[])} for f in data['testResults'] for a in f['assertionResults'] if a['status'] in ['passed','failed']]
        results.append(row);(out/'control-results.json').write_text(json.dumps(results,indent=2)+'\n')
        print(label,kind,rc,round(row['seconds'],2),[(x['status'],round(x['durationMs'] or 0)) for x in row.get('tests',[])],flush=True)

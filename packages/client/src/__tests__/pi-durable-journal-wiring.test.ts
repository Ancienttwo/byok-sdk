import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { DurableRecovery } from '../adapters/pi-durable/recovery';
import type { RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult, RuntimeOperationStartInput } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
const roots: string[] = [];
let daemon: Daemon | undefined, journal: SqliteLocalTaskJournal | undefined, server: TestServer | undefined;
let release: (() => void) | undefined;
afterEach(async () => { release?.(); await daemon?.stop(); await journal?.close(); await server?.close(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); });
it('TaskRunner waits for the real durable journal commit before ACK and leaves recoverable interrupted work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'byok-durable-journal-')); roots.push(root);
  const storeDir = path.join(root,'store'); journal = new SqliteLocalTaskJournal({storeDir});
  const write = journal.recordTransition.bind(journal);
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false, acknowledged = false, captured: RuntimeOperationStartInput | undefined;
  vi.spyOn(journal,'recordTransition').mockImplementation(async record => {
    if (record.detail && JSON.parse(record.detail).kind === 'tool-intent') { entered = true; await gate; }
    await write(record);
  });
  class Adapter extends StubRuntimeAdapter {
    override async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
      const base = await super.prepare(input); if (base.kind !== 'prepared') throw new Error('fixture refused');
      return {kind:'prepared',operation:{
        resolveRuntimeLaunch: async () => ({kind:'pi-durable',release:async()=>{}} as never),
        start: async resources => {
          captured = resources;
          if (!resources.durableContext) throw new Error('TaskRunner omitted durable lifecycle');
          const recovery = new DurableRecovery(resources.durableContext.lifecycle);
          await recovery.beforeTool('tool-id'); acknowledged = true;
          await recovery.committedTool('tool-id'); await recovery.crash();
          return base.operation.start(resources);
        },
      }};
    }
  }
  const adapter = new Adapter('pi'); server = await TestServer.start();
  daemon = createDaemonWithAdapters({ localAgentRelease:{version:'0.0.0-test'},productName:'Test',productId:'durable-wiring',serverUrl:server.url,
    storeDir, workspaceRoot:path.join(root,'workspace'),agentHome:{hostStorageRoot:path.join(root,'home')},hostedJournal:{mode:'sqlite'},durablePi:true,
    piByokLauncher:{command:'unused-custody',profileDbPath:path.join(root,'profiles'),sessionDir:path.join(root,'sessions')},
  },[adapter],{hostedJournal:{journal}});
  const record = await daemon.pair('pairing-code'); await daemon.start();
  server.send(createEnvelope('task.offer_for_agent',{instruction:'Host input',policy:{mode:'auto'},runtime:'pi',agentRef:{agentId:'durable-agent',profileRevision:'1'}},{taskId:'durable-wiring-task',seq:server.nextSeq()}));
  await vi.waitFor(() => expect(entered).toBe(true));
  expect(acknowledged).toBe(false);
  const db = new DatabaseSync(path.join(storeDir,'daemon.db'),{readOnly:true});
  try {
    expect(db.prepare('SELECT count(*) AS n FROM journal_transition').get()).toEqual({n:0});
    expect(db.prepare('SELECT local_state FROM journal_task').get()).toEqual({local_state:'admitted'});
    release!(); await server.waitFor(event => event.type === 'task.started' && event.task_id === 'durable-wiring-task');
    expect(acknowledged).toBe(true);
    const rows = db.prepare('SELECT detail,to_state,from_state FROM journal_transition ORDER BY rowid').all() as Array<{detail:string;to_state:string;from_state:string|null}>;
    expect(rows.map(row => JSON.parse(row.detail).kind)).toEqual(['tool-intent','tool-committed','respawn-intent']);
    expect(rows.map(row => JSON.parse(row.detail).leaseId)).toEqual(Array(3).fill(captured!.manifest.lease!.leaseId));
    expect(rows.map(row => row.to_state)).toEqual(['running','running','running']);
    expect(rows.map(row => row.from_state)).toEqual([null,null,null]);
    const recovery = await journal.listRecoveryTasks({tenantId:'tenant-test',productId:'durable-wiring',deviceId:record.deviceId});
    expect(recovery).toMatchObject([{taskId:'durable-wiring-task',localState:'running',claimedRuntime:'pi'}]);
    expect(JSON.parse(recovery[0]!.envelopeBytes).payload.agentRef).toEqual({agentId:'durable-agent',profileRevision:'1'});
  } finally { db.close(); }
});

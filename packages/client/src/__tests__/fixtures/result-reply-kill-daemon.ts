import { readFileSync, writeFileSync } from 'node:fs';
import { SqliteLocalTaskJournal } from '../../daemon/journal/sqlite-journal';
import { StubRuntimeAdapter } from './stub-adapter';
import { InMemoryDeviceCredentialStore } from './credential-backend';
import { waitForDaemonOpen } from './lifecycle-barrier';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const { createDaemonWithAdapters } = await import(input.clientEntry);
const credentials = new InMemoryDeviceCredentialStore();
await credentials.replace(input.credentials);
const journal = new SqliteLocalTaskJournal({ storeDir: input.config.storeDir });
const originalTransition = journal.recordTransition.bind(journal);
journal.recordTransition = async record => {
  await originalTransition(record);
  if (input.checkpointMode === 'marker-before-draft-activation' && record.to === 'required-reply-result-missing') {
    writeFileSync(input.checkpoint, 'marker-before-draft-activation');
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
};
const original = journal.recordTerminal.bind(journal);
journal.recordTerminal = async record => {
  if (input.checkpointMode !== 'marker-before-draft-activation' && JSON.parse(record.bytes).payload?.reason?.startsWith('result_not_submitted:')) {
    writeFileSync(input.checkpoint, 'accepted-before-terminal');
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  return original(record);
};
const adapter = new StubRuntimeAdapter('pi');
const prepare = adapter.prepare.bind(adapter);
adapter.prepare = async offer => {
  const result = await prepare(offer);
  if (result.kind === 'prepared') {
    const start = result.operation.start.bind(result.operation);
    result.operation.start = async args => {
      const session = await start(args);
      setTimeout(() => {
        adapter.sessions[0]!.emit({ type: 'progress', text: 'Crash-safe required reply.' });
        adapter.sessions[0]!.emit({ type: 'turn_end' });
      }, 25);
      return session;
    };
  }
  return result;
};
const daemon = createDaemonWithAdapters(input.config, [adapter], { deviceCredentials: credentials, journal });
await daemon.start();
// start() only schedules connection work. The parent submits a capability-gated
// task on this signal, so wait for the server-accepted conn.hello first.
await waitForDaemonOpen(daemon);
process.stdout.write('ready\n');

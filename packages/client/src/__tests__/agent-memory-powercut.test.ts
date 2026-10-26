import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMemoryIntentCompletion } from '@byok-sdk/protocol';
import {
  serializeAgentMemoryIntentLedger,
  type AgentMemoryIntentLedgerRecord,
} from '../daemon/agent-memory-intent';
import { checkCut, checkRecovery, type CutCheck, type InvariantId } from './agent-memory-powercut/checker';
import { powercutTriggers } from './agent-memory-powercut/cli';
import { ProcessKillDriver, QemuDriver, qmpExecute, taskkillNamedProcesses, windowsTree, type PowerCutDriver, type StorageProfile } from './agent-memory-powercut/drivers';
import { runExperiment } from './agent-memory-powercut/experiment';
import { contentRevision, HostJournal, PowercutHost, powercutContent, type IssuedIntent } from './agent-memory-powercut/host';
import { writeMessage } from './agent-memory-powercut/protocol';
import { EMPTY_REVISION, revisionOf, type DeviceSnapshot, type FileObservation, type HomeSnapshot } from './agent-memory-powercut/snapshot';
import { builtAgentMemoryFilesystemHelperBin } from './fixtures/agent-memory-helper-build';
import { resolveBunBin } from './support/test-bun-bin';

const roots: string[] = [];
function scratch(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'byok-w5-')));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const STAMP = '2026-10-26T00:00:00.000Z';

/**
 * A device that did everything right, built with the real ledger serializer:
 * every intent applied, completed and acknowledged. Each mutation below
 * breaks one durability claim and must turn exactly the matching invariant.
 */
async function consistentRun(intents: number) {
  const journal = new HostJournal();
  const host = new PowercutHost({ seed: 5, intentsPerHome: intents, journal });
  const records: AgentMemoryIntentLedgerRecord[] = [];
  const files: Record<string, FileObservation> = {};
  const issued: IssuedIntent[] = [];
  for (let index = 0; index < intents; index += 1) {
    const intent = await host.issueNext();
    issued.push(intent);
    const result = intent.targetRevision === null
      ? { exists: false, revision: EMPTY_REVISION }
      : { exists: true, revision: intent.targetRevision };
    records.push({
      intentId: intent.intentId, profileRevision: '1', path: intent.path, operation: intent.operation,
      operationDigest: intent.operationDigest, baseRevision: intent.baseRevision, targetRevision: intent.targetRevision,
      approvalRef: `approval:w5-${intent.seq}`, state: 'applied', detail: result, createdAt: STAMP, updatedAt: STAMP, ackedAt: STAMP,
    });
    if (result.exists) files[intent.path] = { exists: true, size: Buffer.byteLength(powercutContent(intent.seq)), revision: result.revision };
    else delete files[intent.path];
    const completion: AgentMemoryIntentCompletion = {
      intentId: intent.intentId, agentRef: intent.agentRef, path: intent.path, operation: intent.operation,
      operationDigest: intent.operationDigest, outcome: 'applied', result,
    };
    host.complete(completion);
    host.acked(intent.intentId);
  }
  files['MEMORY.md'] ??= { exists: true, size: 0, revision: EMPTY_REVISION };
  return { host, journal, records, files, issued };
}

function home(records: readonly AgentMemoryIntentLedgerRecord[], files: Record<string, FileObservation>, agentId = 'w5-agent-0'): HomeSnapshot {
  return {
    agentId, notesDirectory: true, internalDirectory: true,
    ledgerBase64: Buffer.from(serializeAgentMemoryIntentLedger(records)).toString('base64'),
    files, leftovers: [], leaseMarker: 'absent',
  };
}

function snapshot(homes: HomeSnapshot[]): DeviceSnapshot {
  return { platform: 'test', arch: 'test', runtime: 'test', homes };
}

function violated(check: CutCheck): InvariantId[] {
  return check.invariants.filter((entry) => entry.status === 'violated').map((entry) => entry.id);
}

describe('W5 checker', () => {
  it('holds every invariant for a consistent device', async () => {
    const run = await consistentRun(6);
    const check = checkCut(snapshot([home(run.records, run.files)]), run.journal.entries);
    expect(check.invariants.map((entry) => [entry.id, entry.status, entry.details])).toEqual(
      (['I1', 'I2', 'I3', 'I4', 'I5'] as const).map((id) => [id, 'held', []]));
    expect(check.window).toBe('acked');
  });

  it('refuses a torn ledger, and then cannot vouch for the Host receipts', async () => {
    const run = await consistentRun(4);
    const torn = home(run.records, run.files);
    const bytes = Buffer.from(torn.ledgerBase64!, 'base64');
    const check = checkCut(snapshot([{ ...torn, ledgerBase64: bytes.subarray(0, bytes.byteLength - 7).toString('base64') }]), run.journal.entries);
    expect(violated(check)).toEqual(['I1', 'I2', 'I3', 'I4']);
    expect(check.invariants[0]!.details[0]).toContain('strict parser refused the ledger');
    expect(check.invariants[1]!.details[0]).toContain('the ledger is unreadable');
  });

  it('flags a terminal that rolled back to applying under a Host receipt (#522)', async () => {
    const run = await consistentRun(4);
    const last = run.records.at(-1)!;
    const rolledBack = [...run.records.slice(0, -1), { ...last, state: 'applying' as const, detail: null, ackedAt: null }];
    const check = checkCut(snapshot([home(rolledBack, run.files)]), run.journal.entries);
    expect(violated(check)).toEqual(['I2', 'I3']);
    expect(check.invariants[1]!.details[0]).toMatch(/Host holds .*applied.*device ledger is applying/u);
  });

  it('flags a ledger that lost the record of a received completion', async () => {
    const run = await consistentRun(4);
    const check = checkCut(snapshot([home(run.records.slice(0, -1), run.files)]), run.journal.entries);
    expect(violated(check)).toContain('I2');
    expect(check.invariants[1]!.details[0]).toContain('the ledger has no record for it');
  });

  it('flags an acknowledged intent whose ackedAt was not durable', async () => {
    const run = await consistentRun(3);
    const records = run.records.map((record, index) => (index === 1 ? { ...record, ackedAt: null } : record));
    expect(violated(checkCut(snapshot([home(records, run.files)]), run.journal.entries))).toEqual(['I3']);
  });

  it('flags memory that does not match an applied terminal', async () => {
    const run = await consistentRun(5);
    const replace = run.issued.findLast((intent) => intent.targetRevision !== null)!;
    const files = { ...run.files, [replace.path]: { exists: true, size: 1, revision: EMPTY_REVISION } };
    const check = checkCut(snapshot([home(run.records, files)]), run.journal.entries);
    expect(violated(check)).toEqual(['I4']);
  });

  it('flags torn memory content as no issued body', async () => {
    const run = await consistentRun(5);
    const replace = run.issued.findLast((intent) => intent.targetRevision !== null)!;
    const half = Buffer.from(powercutContent(replace.seq)).subarray(0, 4096 * 3);
    const files = { ...run.files, [replace.path]: { exists: true, size: half.byteLength, revision: revisionOf(half) } };
    expect(violated(checkCut(snapshot([home(run.records, files)]), run.journal.entries))).toEqual(['I4', 'I5']);
  });

  it('flags a missing Agent home under a Host receipt (new home chain)', async () => {
    const run = await consistentRun(2);
    const check = checkCut(snapshot([]), run.journal.entries);
    expect(violated(check)).toEqual(['I2', 'I3']);
    expect(check.invariants[1]!.details[0]).toContain('the Agent home is missing');
  });

  it('flags memory written although no applying record exists', async () => {
    const run = await consistentRun(1);
    const intent = run.issued[0]!;
    const withoutLedger = { ...home([], run.files), ledgerBase64: null };
    const journal = run.journal.entries.filter((entry) => entry.kind === 'issued');
    const check = checkCut(snapshot([withoutLedger]), journal);
    expect(intent.targetRevision).not.toBeNull();
    expect(violated(check)).toEqual(['I4']);
    expect(check.window).toBe('no-record');
  });

  it('flags a record the Host never issued', async () => {
    const run = await consistentRun(2);
    const other = await consistentRun(1);
    const check = checkCut(snapshot([home([...run.records, other.records[0]!], run.files)]), run.journal.entries);
    expect(violated(check)).toContain('I1');
  });

  it('checks recovery: every open intent acknowledged with the stored completion', async () => {
    const run = await consistentRun(2);
    const open = run.issued.slice(-1);
    const id = open[0]!.intentId;
    expect(checkRecovery(open, [{ kind: 'repeat', intentId: id, disposition: 'idempotent' }, { kind: 'acked', intentId: id }]).status).toBe('held');
    expect(checkRecovery(open, [{ kind: 'repeat', intentId: id, disposition: 'conflict' }, { kind: 'acked', intentId: id }]).status).toBe('violated');
    expect(checkRecovery(open, [{ kind: 'failed', intentId: id, reason: 'ledger_invalid' }]).details).toEqual([
      `intent ${id}: notice failed with ledger_invalid`, `intent ${open[0]!.seq}: still open after recovery`,
    ]);
  });

  it('issues bodies that span many clusters and stay under the intent limit', () => {
    for (const seq of [0, 1, 17, 499]) {
      const bytes = Buffer.byteLength(powercutContent(seq));
      expect(bytes).toBeGreaterThanOrEqual(40 * 1024);
      expect(bytes).toBeLessThan(256 * 1024);
    }
    expect(contentRevision(powercutContent(3))).not.toBe(contentRevision(powercutContent(4)));
  });
});

// Linux runs the procfs descriptor backend. macOS and Windows need the built
// release helper. Windows also needs the test-only B seam in device.ts.
const BUN_BIN = resolveBunBin();
const BACKEND = process.platform === 'linux' || builtAgentMemoryFilesystemHelperBin() !== undefined;
const CLI = fileURLToPath(new URL('./agent-memory-powercut/cli.ts', import.meta.url));

/**
 * Runs one experiment and always ends what it started. A run that throws
 * reports the device's stderr, and a device process that outlives the run
 * fails it too.
 */
async function closing<T>(driver: PowerCutDriver, stderr: readonly string[], run: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    const closeError = await driver.close().then(() => undefined, (failure: unknown) => failure);
    const lines = [String(error), ...(closeError === undefined ? [] : [`close: ${String(closeError)}`]), 'device stderr:', ...stderr];
    throw new Error(lines.join('\n'), { cause: error });
  }
  await driver.close();
  return result;
}

/** A device program that reports its store, then exits on its first notice, or never answers one. */
function fakeDevice(dir: string, exitAt: 'start' | 'notice' | 'never'): string {
  const file = path.join(dir, 'fake-device.ts');
  const module = (name: string) => JSON.stringify(fileURLToPath(new URL(`./agent-memory-powercut/${name}.ts`, import.meta.url)));
  writeFileSync(file, [
    `import { readMessages, writeMessage } from ${module('protocol')};`,
    `import { takeDeviceSnapshot } from ${module('snapshot')};`,
    exitAt === 'start' ? `console.error('fake device: no snapshot'); process.exit(7);` : '',
    `writeMessage(process.stdout, { type: 'snapshot', snapshot: await takeDeviceSnapshot(process.argv[2]!) });`,
    `writeMessage(process.stdout, { type: 'ready' });`,
    exitAt === 'never'
      ? `for await (const _message of readMessages<{ type: string }>(process.stdin)) continue;`
      : `for await (const message of readMessages<{ type: string }>(process.stdin)) if (message.type === 'notice') process.exit(3);`,
  ].join('\n'));
  return file;
}

describe('W5 process-crash run', () => {
  it.skipIf(BUN_BIN === undefined || !BACKEND)('kills the device tree at Host points and random times; every invariant holds', async () => {
    const store = scratch();
    const journal = new HostJournal(path.join(scratch(), 'journal.jsonl'));
    const driver = new ProcessKillDriver({ command: BUN_BIN!, args: [CLI, 'device', '--store', store] });
    try {
      const report = await closing(driver, driver.stderr, () => runExperiment({
        driver, host: new PowercutHost({ seed: 11, intentsPerHome: 3, journal }), triggers: powercutTriggers(14, 11, 600),
      }));
      // Which windows the cuts landed in depends on timing; it is reported, not asserted.
      console.log(`W5 ${process.platform} cut windows: ${JSON.stringify(report.windows)}`);
      const failures = report.cuts.flatMap((cut) => [...cut.invariants, cut.recovery!]
        .filter((entry) => entry.status !== 'held').map((entry) => `${cut.trigger} ${entry.id}: ${entry.details.join('; ')}`));
      expect({ failures, stoppedEarly: report.stoppedEarly, stderr: failures.length === 0 ? [] : driver.stderr }).toEqual({ failures: [], stoppedEarly: undefined, stderr: [] });
      expect(report.cuts).toHaveLength(14);
      expect(report.evidence).toBe('process-crash');
      if (process.platform === 'win32') {
        // Each cut saw every process taskkill named gone. Whether a cut hit a
        // live helper depends on its timing, so it is reported, not asserted.
        const kills = driver.windowsKills;
        console.log(`W5 Windows kills: ${kills.filter((kill) => kill.helperAlive).length} of ${kills.length} cuts hit a live helper; ${JSON.stringify(kills)}`);
        expect(kills).toHaveLength(14);
        for (const kill of kills) expect(kill.killed.filter((entry) => entry.role === 'device')).toHaveLength(1);
      }
      // A Host point stops answering at one message, so its window is exact.
      expect(report.cuts.slice(0, 6).map((cut) => [cut.trigger, cut.window])).toEqual([
        ['host:fetch@1', 'no-record'],
        ['host:complete@1', 'receipt-without-ack'],
        ['host:acked@1', 'acked'],
        ['host:fetch@2', 'no-record'],
        ['host:complete@3', 'receipt-without-ack'],
        ['host:acked@2', 'acked'],
      ]);
    } finally {
      journal.close();
    }
  }, 180_000);

  // A delay cut can fire while the Host is still issuing the next intent.
  // The run must see the cut instead of delivering to the gone device.
  it.skipIf(BUN_BIN === undefined || !BACKEND)('takes a cut that fires while the Host issues an intent', async () => {
    const store = scratch();
    class SlowHost extends PowercutHost {
      override async issueNext(): Promise<IssuedIntent> {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return super.issueNext();
      }
    }
    const driver = new ProcessKillDriver({ command: BUN_BIN!, args: [CLI, 'device', '--store', store] });
    const report = await closing(driver, driver.stderr, () => runExperiment({
      driver, host: new SlowHost({ seed: 11, intentsPerHome: 3, journal: new HostJournal() }), triggers: [{ kind: 'delay', ms: 20 }],
    }));
    expect(report.stoppedEarly).toBeUndefined();
    expect(report.cuts.map((cut) => [cut.intentsBeforeCut, cut.window, cut.recovery?.status])).toEqual([[1, 'no-record', 'held']]);
    expect(report.violations).toBe(0);
  }, 30_000);

  // Negative control: storage that tears the ledger at the cut. The same loop
  // must report the torn ledger, the lost receipt and the failed recovery.
  it.skipIf(BUN_BIN === undefined || !BACKEND)('reports a ledger the storage tore at the cut', async () => {
    const store = scratch();
    const journal = new HostJournal();
    const inner = new ProcessKillDriver({ command: BUN_BIN!, args: [CLI, 'device', '--store', store] });
    const ledger = path.join(store, 'agents', 'w5-agent-0', '.byok', 'agent-memory-intents-v1.json');
    const driver: PowerCutDriver = {
      fault: inner.fault,
      storageProfile: { id: 'test-tears-ledger', dropsUnflushedWrites: true, description: 'tears the first ledger at each cut' },
      start: () => inner.start(),
      stop: () => inner.stop(),
      close: () => inner.close(),
      cut: async () => {
        await inner.cut();
        truncateSync(ledger, Math.floor(statSync(ledger).size / 2));
      },
    };
    const report = await closing(driver, inner.stderr, () => runExperiment({
      driver, host: new PowercutHost({ seed: 11, intentsPerHome: 3, journal }), triggers: [{ kind: 'host', on: 'complete', intent: 1 }],
    }));
    const cut = report.cuts[0]!;
    expect(cut.invariants.filter((entry) => entry.status === 'violated').map((entry) => entry.id)).toEqual(['I1', 'I2', 'I4']);
    expect(cut.recovery).toEqual({ id: 'I6', status: 'violated', details: [expect.stringContaining('notice failed with ledger_invalid'), expect.stringContaining('still open after recovery')] });
    expect(report.stoppedEarly).toMatch(/did not settle/u);
  }, 60_000);

  // A device that exits on its own in a delay round is not a cut. The run
  // stops there, and the delay never signals a process that is gone.
  it.skipIf(BUN_BIN === undefined)('stops when the device exits before a delay cut, and sends no signal', async () => {
    const dir = scratch();
    const inner = new ProcessKillDriver({ command: BUN_BIN!, args: [fakeDevice(dir, 'notice'), scratch()] });
    let cuts = 0;
    const driver: PowerCutDriver = {
      fault: inner.fault, storageProfile: inner.storageProfile,
      start: () => inner.start(), stop: () => inner.stop(), close: () => inner.close(),
      cut: () => { cuts += 1; return inner.cut(); },
    };
    const report = await closing(driver, inner.stderr, () => runExperiment({
      driver, host: new PowercutHost({ seed: 11, intentsPerHome: 3, journal: new HostJournal() }), triggers: [{ kind: 'delay', ms: 1_000 }],
    }));
    expect(report.stoppedEarly).toBe('round 0: the device exited before the cut');
    expect(report.cuts).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(cuts).toBe(0);
  }, 20_000);

  // The device keeps its connection and never answers the notice, so only
  // the failed cut can end the wait for that delivery.
  it.skipIf(BUN_BIN === undefined)('fails the run when a cut fails while a notice is in flight', async () => {
    const inner = new ProcessKillDriver({ command: BUN_BIN!, args: [fakeDevice(scratch(), 'never'), scratch()] });
    const driver: PowerCutDriver = {
      fault: inner.fault, storageProfile: inner.storageProfile,
      start: () => inner.start(), stop: () => inner.stop(), close: () => inner.close(),
      cut: async () => { throw new Error('the storage layer refused the cut'); },
    };
    const started = Date.now();
    await expect(closing(driver, inner.stderr, () => runExperiment({
      driver, host: new PowercutHost({ seed: 11, intentsPerHome: 3, journal: new HostJournal() }), triggers: [{ kind: 'delay', ms: 100 }],
    }))).rejects.toThrow(/refused the cut/u);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it.skipIf(BUN_BIN === undefined)('refuses to cut a device that already exited', async () => {
    const driver = new ProcessKillDriver({ command: BUN_BIN!, args: [fakeDevice(scratch(), 'notice'), scratch()] });
    try {
      const run = await driver.start();
      writeMessage(run.link.output, { type: 'notice', payload: { intentId: 'gone', agentRef: { agentId: 'w5-agent-0', profileRevision: '1' } } });
      await run.ended;
      await expect(driver.cut()).rejects.toThrow(/exited before the cut/u);
    } finally {
      await driver.close();
    }
  }, 20_000);

  it.skipIf(BUN_BIN === undefined)('fails at once, with its stderr, when the device dies before its snapshot', async () => {
    const driver = new ProcessKillDriver({ command: BUN_BIN!, args: [fakeDevice(scratch(), 'start'), scratch()] });
    const started = Date.now();
    await expect(closing(driver, driver.stderr, () => runExperiment({
      driver, host: new PowercutHost({ seed: 11, intentsPerHome: 3, journal: new HostJournal() }), triggers: [{ kind: 'delay', ms: 100 }],
    }))).rejects.toThrow(/ended before it sent its snapshot[\s\S]*fake device: no snapshot/u);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

const FAKE_QEMU = `
const fs = require('node:fs');
const net = require('node:net');
const [socketPath, log] = process.argv.slice(1);
try { fs.unlinkSync(socketPath); } catch {}
net.createServer((socket) => {
  socket.write(JSON.stringify({ QMP: { version: {}, capabilities: [] } }) + '\\n');
  socket.write(JSON.stringify({ event: 'RESUME' }) + '\\n');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\\n')) >= 0; buffer = buffer.slice(end + 1)) {
      const { execute } = JSON.parse(buffer.slice(0, end));
      fs.appendFileSync(log, execute + '\\n');
      if (execute === 'bogus') socket.write(JSON.stringify({ error: { class: 'CommandNotFound', desc: 'no' } }) + '\\n');
      else socket.write(JSON.stringify({ return: {} }) + '\\n');
      if (execute === 'quit') setTimeout(() => process.exit(0), 10);
    }
  });
}).listen(socketPath);
`;

async function freePort(): Promise<number> {
  const server = net.createServer().listen(0);
  await once(server, 'listening');
  const { port } = server.address() as net.AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

const LOOP_DEADLINE_MS = 10_000;

async function guestConnects(port: number): Promise<net.Socket> {
  const deadline = Date.now() + LOOP_DEADLINE_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`no guest connection to port ${port}`);
    const socket = net.connect({ host: '127.0.0.1', port });
    const outcome = await Promise.race([once(socket, 'connect').then(() => 'up'), once(socket, 'error').then(() => 'down')]);
    if (outcome === 'up') return socket;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function qmpReady(socketPath: string): Promise<void> {
  const deadline = Date.now() + LOOP_DEADLINE_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`no QMP monitor at ${socketPath}`);
    try {
      await qmpExecute(socketPath, 'query-status');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function commands(log: string): string[] {
  return readFileSync(log, 'utf8').split('\n').filter((name) => name !== '' && name !== 'qmp_capabilities' && name !== 'query-status');
}

const DROPS: StorageProfile = { id: 'test-drop', dropsUnflushedWrites: true, description: 'test layer' };

describe('W5 Windows device tree', () => {
  it('reads the tree at the kill from taskkill output, failed terminations included', () => {
    const output = [
      'SUCCESS: The process with PID 4368 (child process of PID 7876) has been terminated.',
      'ERROR: The process with PID 7876 (child process of PID 7292) could not be terminated.',
      'Reason: The operation attempted is not supported.',
      'SUCCESS: The process with PID 7292 (child process of PID 1408) has been terminated.',
    ].join('\r\n');
    expect(taskkillNamedProcesses(output, 7292)).toEqual([
      { pid: 4368, ppid: 7876, role: 'helper-child' },
      { pid: 7876, ppid: 7292, role: 'helper' },
      { pid: 7292, ppid: 1408, role: 'device' },
    ]);
  });

  const entry = (pid: number, ppid: number, created: number, name = `p${pid}`) => ({ pid, ppid, name, created });

  it('follows parent links from the device, and rejects a reused PID and a later process', () => {
    const device = entry(10, 1, 1_000, 'bun.exe');
    const all = [
      device,
      entry(11, 10, 1_100, 'win32-x64.exe'),
      entry(12, 11, 1_101, 'conhost.exe'),
      entry(13, 99, 1_200),
      // PID 14 claims parent 11 but is older than it, so 11 was reused.
      entry(14, 11, 900),
      entry(15, 12, 5_000),
    ];
    expect(windowsTree(all, [device]).map((entry) => entry.pid)).toEqual([10, 11, 12, 15]);
    expect(windowsTree(all, [device], 2_000).map((entry) => entry.pid)).toEqual([10, 11, 12]);
  });
});

describe.skipIf(process.platform === 'win32')('W5 QEMU driver against a fake QEMU monitor', () => {
  it('speaks QMP: greeting, capabilities, events skipped, errors raised', async () => {
    const dir = scratch();
    const qmp = path.join(dir, 'q.sock');
    const fake = spawn(process.execPath, ['-e', FAKE_QEMU, qmp, path.join(dir, 'log')], { stdio: 'ignore' });
    try {
      await qmpReady(qmp);
      await expect(qmpExecute(qmp, 'bogus')).rejects.toThrow(/QMP bogus failed/u);
      expect(await qmpExecute(qmp, 'inject-nmi')).toEqual({});
      expect(commands(path.join(dir, 'log'))).toEqual(['bogus', 'inject-nmi']);
    } finally {
      fake.kill('SIGKILL');
    }
  }, 20_000);

  it('os-crash injects an NMI and keeps QEMU running; power-loss kills QEMU and runs the storage layer', async () => {
    for (const fault of ['os-crash', 'power-loss'] as const) {
      const dir = scratch();
      const qmp = path.join(dir, 'q.sock');
      const log = path.join(dir, 'log');
      const listenPort = await freePort();
      const layer: string[] = [];
      const driver = new QemuDriver({
        fault, command: process.execPath, args: ['-e', FAKE_QEMU, qmp, log], qmpSocket: qmp, listenPort,
        storage: {
          profile: DROPS,
          // The layer is cut while QEMU still answers its monitor.
          cut: async () => { layer.push(await qmpExecute(qmp, 'query-status').then(() => 'cut qemu-alive=true', () => 'cut qemu-alive=false')); },
          prepareBoot: async () => { layer.push('prepare-boot'); },
        },
        bootTimeoutMs: 10_000,
      });
      try {
        expect(driver.storageProfile).toBe(DROPS);
        const first = driver.start();
        const guest = await guestConnects(listenPort);
        const run = await first;
        await qmpReady(qmp);
        await driver.cut();
        await run.ended;
        expect(layer).toEqual(fault === 'power-loss' ? ['cut qemu-alive=true', 'prepare-boot'] : []);
        guest.destroy();
        // The next boot: os-crash reuses the running QEMU, power-loss starts a new one.
        const second = driver.start();
        const rebooted = await guestConnects(listenPort);
        await second;
        await qmpReady(qmp);
        await driver.stop();
        rebooted.destroy();
      } finally {
        await driver.close();
      }
      // Power loss never asks QEMU to quit: a clean quit flushes its block devices.
      expect(commands(log)).toEqual(fault === 'os-crash' ? ['inject-nmi', 'quit'] : ['quit']);
    }
  }, 30_000);

  it('leaves QEMU and the guest connection to close() when a cut or a stop fails', async () => {
    const cases = [
      { name: 'storage cut fails', fault: 'power-loss', monitor: 'real', step: 'cut' },
      { name: 'NMI fails', fault: 'os-crash', monitor: 'missing', step: 'cut' },
      { name: 'quit fails', fault: 'os-crash', monitor: 'missing', step: 'stop' },
    ] as const;
    for (const { name, fault, monitor, step } of cases) {
      const dir = scratch();
      const qmp = path.join(dir, 'q.sock');
      const listenPort = await freePort();
      const driver = new QemuDriver({
        fault, command: process.execPath, args: ['-e', FAKE_QEMU, qmp, path.join(dir, 'log')],
        qmpSocket: monitor === 'real' ? qmp : path.join(dir, 'missing.sock'), listenPort,
        storage: {
          profile: DROPS,
          cut: async () => { throw new Error('storage layer refused the cut'); },
          prepareBoot: async () => {},
        },
        bootTimeoutMs: 10_000,
      });
      let guest: net.Socket | undefined;
      try {
        const first = driver.start();
        guest = await guestConnects(listenPort);
        const run = await first;
        await qmpReady(qmp);
        await expect(step === 'cut' ? driver.cut() : driver.stop(), name).rejects.toThrow();
        await driver.close();
        await run.ended;
        await expect(qmpExecute(qmp, 'query-status'), `${name}: QEMU outlived close()`).rejects.toThrow();
      } finally {
        guest?.destroy();
        await driver.close();
      }
    }
  }, 30_000);
});

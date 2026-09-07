import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeEnvelope } from '@byok-sdk/protocol';

interface ChildConfig {
  readonly productId: string;
  readonly serverUrl: string;
  readonly storeDir: string;
  readonly workspaceRoot: string;
  readonly controlDir: string;
  readonly pairingCode?: string;
  readonly action?: 'run' | 'unpair';
  readonly journalFault?: string;
  readonly recoveryFault?: string;
  readonly agentHome?: boolean;
}

interface JsonLine {
  readonly id?: number;
  readonly ready?: boolean;
  readonly deviceId?: string;
  readonly result?: unknown;
  readonly error?: string;
}

class JsonChild {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly events: JsonLine[] = [];
  private readonly waiters: Array<() => void> = [];
  private nextId = 1;
  private stdoutBuffer = '';
  stderr = '';

  constructor(executable: string, configPath: string) {
    const childEnv = { ...process.env };
    // The ordinary client test suite selects a process-local credential double.
    // This fixture deliberately crosses real process deaths, so it must exercise
    // the shipped OS credential authority that survives those deaths.
    delete childEnv.BYOK_TEST_DEVICE_CREDENTIAL_STORE;
    this.child = spawn(executable, [configPath], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderr += chunk; });
    this.child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      for (;;) {
        const newline = this.stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.stdoutBuffer.slice(0, newline);
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (line.trim() === '') continue;
        this.events.push(JSON.parse(line) as JsonLine);
        for (const wake of this.waiters.splice(0)) wake();
      }
    });
  }

  async waitFor(predicate: (event: JsonLine) => boolean, timeoutMs = 10_000): Promise<JsonLine> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.events.findIndex(predicate);
      if (index >= 0) return this.events.splice(index, 1)[0]!;
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`fixture exited before expected event (${this.child.exitCode ?? this.child.signalCode}): ${this.stderr}`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for fixture event: ${this.stderr}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 100));
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  async ready(): Promise<JsonLine> {
    return this.waitFor((event) => event.ready === true);
  }

  async rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
    const response = await this.waitFor((event) => event.id === id);
    if (response.error !== undefined) throw new Error(response.error);
    return response.result;
  }

  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }

  async exited(timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return { code: this.child.exitCode, signal: this.child.signalCode };
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture did not exit: ${this.stderr}`)), timeoutMs);
      this.child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  }
}

let suiteRoot: string;
let daemonBin: string;
let cloudBin: string;
let current: {
  root: string;
  productId: string;
  port: number;
  cloudDb: string;
  cloudConfig: string;
  daemonBase: Omit<ChildConfig, 'pairingCode'>;
  children: JsonChild[];
} | undefined;

async function run(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: path.resolve(import.meta.dirname, '../../../..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal})\n${stdout}\n${stderr}`));
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('failed to allocate fixture port'));
      server.close(() => resolve(address.port));
    });
  });
}

async function writeConfig(name: string, value: unknown): Promise<string> {
  const file = path.join(current?.root ?? suiteRoot, `${name}-${randomUUID()}.json`);
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

async function startCloud(): Promise<JsonChild> {
  if (current === undefined) throw new Error('test context missing');
  const child = new JsonChild(cloudBin, current.cloudConfig);
  current.children.push(child);
  await child.ready();
  return child;
}

async function startDaemon(options: Partial<ChildConfig> = {}): Promise<JsonChild> {
  if (current === undefined) throw new Error('test context missing');
  const config = { ...current.daemonBase, ...options };
  const child = new JsonChild(daemonBin, await writeConfig('daemon', config));
  current.children.push(child);
  await child.ready();
  return child;
}

async function spawnDaemon(options: Partial<ChildConfig> = {}): Promise<JsonChild> {
  if (current === undefined) throw new Error('test context missing');
  const child = new JsonChild(daemonBin, await writeConfig('daemon-crash', { ...current.daemonBase, ...options }));
  current.children.push(child);
  return child;
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.access(file);
      return;
    } catch {}
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForAttempt(cloud: JsonChild, taskId: string, status: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await cloud.rpc('readTaskAttempt', { taskId }) as Record<string, unknown> | undefined;
    if (attempt?.status === status) return attempt;
    if (Date.now() >= deadline) throw new Error(`task ${taskId} did not reach ${status}; last=${JSON.stringify(attempt)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function journalRows(sql: string): Record<string, unknown>[] {
  if (current === undefined) throw new Error('test context missing');
  const db = new DatabaseSync(path.join(current.daemonBase.storeDir, 'daemon.db'), { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function starts(): Array<{ taskId: string; pid: number; instruction: string }> {
  if (current === undefined) throw new Error('test context missing');
  const file = path.join(current.daemonBase.controlDir, 'runtime-starts.jsonl');
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForJournalTruth(state: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (journalRows('SELECT truth_state FROM journal_terminal').some((row) => row.truth_state === state)) return;
    if (Date.now() >= deadline) throw new Error(`journal terminal did not reach ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function arm(name: string): Promise<void> {
  if (current === undefined) throw new Error('test context missing');
  await fs.writeFile(path.join(current.daemonBase.controlDir, `${name.replaceAll(':', '-')}.arm`), 'armed\n');
}

async function finish(taskId: string, summary: string): Promise<void> {
  if (current === undefined) throw new Error('test context missing');
  await fs.writeFile(path.join(current.daemonBase.controlDir, `${taskId}.finish.json`), JSON.stringify({ summary }));
}

async function pair(cloud: JsonChild, daemonOptions: Partial<ChildConfig> = {}): Promise<{ daemon: JsonChild; deviceId: string }> {
  const pairing = await cloud.rpc('createPairingCode') as { code: string };
  const daemon = await startDaemon({ ...daemonOptions, pairingCode: pairing.code });
  // startDaemon consumed the ready event. Device id is persisted in device.json and is the non-secret projection authority.
  const projection = JSON.parse(await fs.readFile(path.join(current!.daemonBase.storeDir, 'device.json'), 'utf8')) as { deviceId: string };
  return { daemon, deviceId: projection.deviceId };
}

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-execution-recovery-kill-suite-'));
  daemonBin = path.join(suiteRoot, 'execution-recovery-daemon');
  cloudBin = path.join(suiteRoot, 'execution-recovery-cloud');
  await run('bun', ['build', 'packages/client/src/__tests__/fixtures/execution-recovery-daemon.ts', '--compile', '--outfile', daemonBin]);
  await run('bun', ['build', 'packages/client/src/__tests__/fixtures/execution-recovery-cloud.ts', '--compile', '--outfile', cloudBin]);
}, 120_000);

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-execution-recovery-kill-'));
  const port = await freePort();
  const productId = `execution-recovery-${randomUUID()}`;
  const cloudDb = path.join(root, 'cloud.db');
  const faultFile = path.join(root, 'cloud-after-commit.arm');
  const faultReachedFile = path.join(root, 'cloud-after-commit.reached');
  const receiptFaultFile = path.join(root, 'cloud-receipt-insert.arm');
  const receiptFaultReachedFile = path.join(root, 'cloud-receipt-insert.reached');
  const cloudConfig = await fs.writeFile(path.join(root, 'cloud-config.json'), JSON.stringify({
    dbPath: cloudDb,
    port,
    productId,
    tokenSecret: '0123456789abcdef0123456789abcdef',
    faultFile,
    faultReachedFile,
    receiptFaultFile,
    receiptFaultReachedFile,
  }), { mode: 0o600 }).then(() => path.join(root, 'cloud-config.json'));
  current = {
    root,
    productId,
    port,
    cloudDb,
    cloudConfig,
    daemonBase: {
      productId,
      serverUrl: `http://127.0.0.1:${port}`,
      storeDir: path.join(root, 'daemon-store'),
      workspaceRoot: path.join(root, 'workspace'),
      controlDir: path.join(root, 'control'),
    },
    children: [],
  };
});

afterEach(async () => {
  if (current === undefined) return;
  for (const child of current.children) child.kill();
  await Promise.all(current.children.map((child) => child.exited().catch(() => undefined)));
  const unpair = new JsonChild(daemonBin, await writeConfig('unpair', { ...current.daemonBase, action: 'unpair' }));
  const cleanup = await unpair.exited();
  if (cleanup.code !== 0) throw new Error(`fixture credential cleanup failed (${cleanup.code ?? cleanup.signal}): ${unpair.stderr}`);
  await fs.rm(current.root, { recursive: true, force: true });
  current = undefined;
});

afterAll(async () => {
  if (suiteRoot !== undefined) await fs.rm(suiteRoot, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'darwin')('compiled daemon SIGKILL execution recovery against reconstructed durable cloud stores', () => {
  it('recovers a never-admitted message through repeated SIGKILL before delivering its interrupted terminal', async () => {
    const cloud = await startCloud();
    const { daemon, deviceId } = await pair(cloud, { agentHome: true });
    await fs.writeFile(`${current!.cloudDb}.message-outage`, '503');
    const offer = await cloud.rpc('enqueueMessageOffer', { deviceId }) as { taskId: string };
    await waitForFile(`${current!.cloudDb}.message-blocked`);
    const originalPayload = JSON.parse(await fs.readFile(`${current!.cloudDb}.message-blocked`, 'utf8'));
    expect(await cloud.rpc('readMessages')).toEqual([]);
    daemon.kill();
    await daemon.exited();

    const second = await startDaemon({ agentHome: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const [pending] = journalRows('SELECT bytes, truth_state FROM journal_terminal');
    expect(pending?.truth_state).toBe('pending');
    expect((await cloud.rpc('readTaskAttempt', { taskId: offer.taskId }) as { status: string }).status).toBe('running');
    second.kill();
    await second.exited();
    cloud.kill();
    await cloud.exited();
    await fs.unlink(`${current!.cloudDb}.message-outage`);
    const restoredCloud = await startCloud();
    await arm('terminal:before-send');
    const afterDisposition = await spawnDaemon({ agentHome: true, recoveryFault: 'terminal:before-send' });
    expect((await afterDisposition.exited()).signal).toBe('SIGKILL');
    expect((await restoredCloud.rpc('readTaskAttempt', { taskId: offer.taskId }) as { status: string }).status).toBe('running');
    expect(journalRows('SELECT bytes, truth_state FROM journal_terminal')).toEqual([pending]);
    const third = await startDaemon({ agentHome: true });
    await waitForAttempt(restoredCloud, offer.taskId, 'failed');
    await waitForJournalTruth('confirmed');
    const messages = await restoredCloud.rpc('readMessages') as Array<{ task_id: string; payload: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.task_id).toBe(offer.taskId);
    expect(JSON.parse(messages[0]!.payload)).toEqual(originalPayload);
    expect(await restoredCloud.rpc('readTerminalBody', { taskId: offer.taskId })).toBe(pending?.bytes);
    const wire = await restoredCloud.rpc('readWire') as Array<{ type: string; task_id?: string }>;
    const publishes = wire.findIndex((row) => row.type === 'agent.message.publish' && row.task_id === offer.taskId);
    const terminal = wire.findIndex((row) => row.type === 'task.fail' && row.task_id === offer.taskId);
    expect(publishes).toBeGreaterThanOrEqual(0);
    expect(terminal).toBeGreaterThan(publishes);
    expect(starts()).toHaveLength(1);
    third.kill();
    await third.exited();
    await startDaemon({ agentHome: true });
    expect(await restoredCloud.rpc('readMessages')).toEqual(messages);
    expect(starts()).toHaveLength(1);
  }, 30_000);

  it('does not bypass cloud cancellation for a never-admitted recovered message', async () => {
    const cloud = await startCloud();
    const { daemon, deviceId } = await pair(cloud, { agentHome: true });
    await fs.writeFile(`${current!.cloudDb}.message-outage`, '503');
    const offer = await cloud.rpc('enqueueMessageOffer', { deviceId }) as { taskId: string };
    await waitForFile(`${current!.cloudDb}.message-blocked`);
    daemon.kill();
    await daemon.exited();
    await cloud.rpc('cancelTask', { taskId: offer.taskId, reason: 'cancel before message admission' });
    await fs.unlink(`${current!.cloudDb}.message-outage`);
    const restarted = await startDaemon({ agentHome: true });
    const deadline = Date.now() + 5000;
    while (!restarted.stderr.includes('inbound_rejected')) {
      if (Date.now() >= deadline) throw new Error(`no message rejection: ${restarted.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await cloud.rpc('readMessages')).toEqual([]);
    expect(await cloud.rpc('readTaskAttempt', { taskId: offer.taskId })).toMatchObject({ cancellation: { reason: 'cancel before message admission' } });
    expect(journalRows('SELECT truth_state FROM journal_terminal')).toEqual([{ truth_state: 'pending' }]);
    expect(starts()).toHaveLength(1);
  }, 30_000);

  it('terminal:before-commit restarts as one non-retryable daemon_interrupted failure without runtime re-execution', async () => {
    const cloud = await startCloud();
    const { daemon, deviceId } = await pair(cloud, { journalFault: 'terminal:before-commit' });
    const offer = await cloud.rpc('enqueueOffer', { deviceId, instruction: 'crash before terminal commit' }) as { taskId: string };
    await waitForFile(path.join(current!.daemonBase.controlDir, 'runtime-starts.jsonl'));
    await finish(offer.taskId, 'must roll back');
    expect((await daemon.exited()).signal).toBe('SIGKILL');
    expect(journalRows('SELECT * FROM journal_terminal')).toHaveLength(0);

    const restarted = await startDaemon();
    const attempt = await waitForAttempt(cloud, offer.taskId, 'failed');
    expect(attempt.terminalCause).toBe('daemon_interrupted');
    expect(starts()).toHaveLength(1);
    const terminal = decodeEnvelope(String(await cloud.rpc('readTerminalBody', { taskId: offer.taskId })));
    expect(terminal.type).toBe('task.fail');
    if (terminal.type === 'task.fail') expect(terminal.payload).toMatchObject({ reason: 'daemon_interrupted', retryable: false });
    const [task] = journalRows('SELECT recovery_marker FROM journal_task');
    expect(JSON.parse(String(task?.recovery_marker))).toMatchObject({ disposition: 'interrupted' });
    expect(journalRows('SELECT terminal_type, truth_state FROM journal_terminal')).toEqual([
      { terminal_type: 'failed', truth_state: 'confirmed' },
    ]);
    restarted.kill();
  }, 30_000);

  it('terminal:after-commit replays the original canonical terminal bytes', async () => {
    const cloud = await startCloud();
    const { daemon, deviceId } = await pair(cloud, { journalFault: 'terminal:after-commit' });
    const offer = await cloud.rpc('enqueueOffer', { deviceId, instruction: 'commit exact terminal bytes' }) as { taskId: string };
    await waitForFile(path.join(current!.daemonBase.controlDir, 'runtime-starts.jsonl'));
    await finish(offer.taskId, 'original summary bytes');
    expect((await daemon.exited()).signal).toBe('SIGKILL');
    const [pending] = journalRows('SELECT bytes, terminal_type, truth_state FROM journal_terminal');
    expect(pending).toMatchObject({ terminal_type: 'complete', truth_state: 'pending' });

    await startDaemon();
    await waitForAttempt(cloud, offer.taskId, 'complete');
    expect(await cloud.rpc('readTerminalBody', { taskId: offer.taskId })).toBe(pending?.bytes);
    expect(journalRows('SELECT truth_state FROM journal_terminal')).toEqual([{ truth_state: 'confirmed' }]);
    expect(starts()).toHaveLength(1);
  }, 30_000);

  it('settles an oversized result as a bounded durable failure without rerunning after restart', async () => {
    const cloud = await startCloud();
    const { daemon, deviceId } = await pair(cloud, { agentHome: true });
    const agentRef = { agentId: 'agent-overflow', profileRevision: 'profile-v1' };
    const offer = await cloud.rpc('enqueueAgentOffer', { deviceId, instruction: 'produce an oversized result', agentRef }) as { taskId: string };
    await waitForFile(path.join(current!.daemonBase.controlDir, 'runtime-starts.jsonl'));
    await finish(offer.taskId, 'x'.repeat(300 * 1024));
    const attempt = await waitForAttempt(cloud, offer.taskId, 'failed');
    expect(attempt.terminalCause).toBe('terminal_result_too_large');
    const terminal = decodeEnvelope(String(await cloud.rpc('readTerminalBody', { taskId: offer.taskId })));
    expect(terminal.type).toBe('task.fail');
    if (terminal.type === 'task.fail') expect(terminal.payload).toMatchObject({ reason: 'terminal_result_too_large', retryable: false, agentRef });
    expect(terminal.task_id).toBe(offer.taskId);
    await waitForJournalTruth('confirmed');
    const [localFailure] = journalRows('SELECT bytes, payload_hash, truth_state FROM journal_terminal');
    expect(localFailure?.truth_state).toBe('confirmed');
    expect(localFailure?.payload_hash).toBeTruthy();
    expect(localFailure?.bytes).toBe(String(await cloud.rpc('readTerminalBody', { taskId: offer.taskId })));
    const confirmedBytes = localFailure?.bytes;
    expect(starts()).toHaveLength(1);
    daemon.kill();
    expect((await daemon.exited()).signal).toBe('SIGKILL');
    await startDaemon();
    expect(starts()).toHaveLength(1);
    const [afterRestart] = journalRows('SELECT bytes, payload_hash, truth_state FROM journal_terminal');
    expect(afterRestart).toMatchObject({ bytes: confirmedBytes, payload_hash: localFailure?.payload_hash, truth_state: 'confirmed' });
  }, 30_000);

  it.each([
    ['recovery:before-commit', false, false],
    ['recovery:after-commit', true, false],
    ['confirm:before-commit', true, false],
    ['confirm:after-commit', true, true],
  ] as const)(
    'an externally killed running daemon converges through a second SIGKILL at %s',
    async (faultStep, terminalCommittedAfterSecond, confirmedAfterSecond) => {
      const cloud = await startCloud();
      const { daemon, deviceId } = await pair(cloud);
      const offer = await cloud.rpc('enqueueOffer', { deviceId, instruction: `external kill then ${faultStep}` }) as { taskId: string };
      await waitForFile(path.join(current!.daemonBase.controlDir, 'runtime-starts.jsonl'));
      await waitForAttempt(cloud, offer.taskId, 'running');
      daemon.kill();
      expect((await daemon.exited()).signal).toBe('SIGKILL');
      expect((await cloud.rpc('readTaskAttempt', { taskId: offer.taskId }) as { status: string }).status).toBe('running');

      const second = await spawnDaemon({ journalFault: faultStep });
      expect((await second.exited()).signal).toBe('SIGKILL');
      const afterSecond = journalRows('SELECT bytes, terminal_type, truth_state FROM journal_terminal');
      expect(afterSecond).toHaveLength(terminalCommittedAfterSecond ? 1 : 0);
      if (terminalCommittedAfterSecond) {
        expect(afterSecond[0]).toMatchObject({ terminal_type: 'failed', truth_state: confirmedAfterSecond ? 'confirmed' : 'pending' });
      }
      const [markerAfterSecond] = journalRows('SELECT recovery_marker FROM journal_task');
      expect(markerAfterSecond?.recovery_marker === null).toBe(!terminalCommittedAfterSecond);

      await startDaemon();
      const attempt = await waitForAttempt(cloud, offer.taskId, 'failed');
      expect(attempt.terminalCause).toBe('daemon_interrupted');
      expect(starts()).toHaveLength(1);
      const [settled] = journalRows('SELECT bytes, terminal_type, truth_state FROM journal_terminal');
      expect(settled).toMatchObject({ terminal_type: 'failed', truth_state: 'confirmed' });
      if (terminalCommittedAfterSecond) expect(settled?.bytes).toBe(afterSecond[0]?.bytes);
      const [task] = journalRows('SELECT recovery_marker FROM journal_task');
      expect(JSON.parse(String(task?.recovery_marker))).toMatchObject({ disposition: 'interrupted' });
      const terminal = decodeEnvelope(String(await cloud.rpc('readTerminalBody', { taskId: offer.taskId })));
      expect(terminal.type).toBe('task.fail');
      if (terminal.type === 'task.fail') expect(terminal.payload).toMatchObject({ reason: 'daemon_interrupted', retryable: false });
    },
    30_000,
  );

  it('a terminal queued only in the memory outbox survives SIGKILL before POST', async () => {
    const cloud = await startCloud();
    const { daemon, deviceId } = await pair(cloud, { recoveryFault: 'terminal:queued' });
    const offer = await cloud.rpc('enqueueOffer', { deviceId, instruction: 'kill after queue' }) as { taskId: string };
    await waitForFile(path.join(current!.daemonBase.controlDir, 'runtime-starts.jsonl'));
    await arm('terminal:queued');
    await finish(offer.taskId, 'queued terminal');
    expect((await daemon.exited()).signal).toBe('SIGKILL');
    expect((await cloud.rpc('readTaskAttempt', { taskId: offer.taskId }) as { status: string }).status).toBe('running');

    await startDaemon();
    await waitForAttempt(cloud, offer.taskId, 'complete');
    expect(starts()).toHaveLength(1);
    expect(journalRows('SELECT truth_state FROM journal_terminal')).toEqual([{ truth_state: 'confirmed' }]);
  }, 30_000);

  it('reconstructs attempts, devices and receipts after cloud receipt commit precedes its response and local confirmation', async () => {
    const cloud = await startCloud();
    const { deviceId } = await pair(cloud);
    const offer = await cloud.rpc('enqueueOffer', { deviceId, instruction: 'cloud dies after durable receipt' }) as { taskId: string };
    await waitForFile(path.join(current!.daemonBase.controlDir, 'runtime-starts.jsonl'));
    writeFileSync(path.join(current!.root, 'cloud-after-commit.arm'), 'armed\n');
    await finish(offer.taskId, 'receipt survived cloud restart');
    expect((await cloud.exited()).signal).toBe('SIGKILL');
    await waitForFile(path.join(current!.root, 'cloud-after-commit.reached'));

    const reconstructed = await startCloud();
    await waitForAttempt(reconstructed, offer.taskId, 'complete');
    const [receipt] = (() => {
      const db = new DatabaseSync(current!.cloudDb, { readOnly: true });
      try { return db.prepare('SELECT body FROM fixture_receipt WHERE receipt_key = ?').all(`task:${offer.taskId}:terminal`) as Record<string, unknown>[]; }
      finally { db.close(); }
    })();
    expect(receipt?.body).toBe(await reconstructed.rpc('readTerminalBody', { taskId: offer.taskId }));
    await waitForFile(path.join(current!.daemonBase.controlDir, `${offer.taskId}.closed`));
    await waitForJournalTruth('confirmed');
    expect(journalRows('SELECT truth_state FROM journal_terminal')).toEqual([{ truth_state: 'confirmed' }]);
    expect(starts()).toHaveLength(1);
  }, 30_000);

  it('reconstructs a first receipt committed inside the store before attempt status and HTTP response', async () => {
    const cloud = await startCloud();
    const { deviceId } = await pair(cloud);
    const offer = await cloud.rpc('enqueueOffer', { deviceId, instruction: 'receipt insert is the first durable cloud fact' }) as { taskId: string };
    await waitForFile(path.join(current!.daemonBase.controlDir, 'runtime-starts.jsonl'));
    writeFileSync(path.join(current!.root, 'cloud-receipt-insert.arm'), 'armed\n');
    await finish(offer.taskId, 'resume cloud apply after receipt insert');
    expect((await cloud.exited()).signal).toBe('SIGKILL');
    await waitForFile(path.join(current!.root, 'cloud-receipt-insert.reached'));

    const reconstructed = await startCloud();
    await waitForAttempt(reconstructed, offer.taskId, 'complete');
    await waitForJournalTruth('confirmed');
    const body = await reconstructed.rpc('readTerminalBody', { taskId: offer.taskId });
    expect(decodeEnvelope(String(body))).toMatchObject({ type: 'task.complete', task_id: offer.taskId });
    expect(starts()).toHaveLength(1);
  }, 30_000);

  it('replays exact bytes when SIGKILL lands after an accepted response but before local confirmation', async () => {
    const cloud = await startCloud();
    const { daemon, deviceId } = await pair(cloud, { recoveryFault: 'outbound:after-ack' });
    const offer = await cloud.rpc('enqueueOffer', { deviceId, instruction: 'kill after authenticated ack' }) as { taskId: string };
    await waitForFile(path.join(current!.daemonBase.controlDir, 'runtime-starts.jsonl'));
    await arm('outbound:after-ack');
    await finish(offer.taskId, 'accepted before local confirmation');
    expect((await daemon.exited()).signal).toBe('SIGKILL');
    await waitForAttempt(cloud, offer.taskId, 'complete');
    const [pending] = journalRows('SELECT bytes, truth_state FROM journal_terminal');
    expect(pending?.truth_state).toBe('pending');

    await startDaemon();
    await waitForJournalTruth('confirmed');
    expect(await cloud.rpc('readTerminalBody', { taskId: offer.taskId })).toBe(pending?.bytes);
    expect(starts()).toHaveLength(1);
  }, 30_000);

  it('preserves a cancellation tombstone over a late original terminal across repeated daemon deaths', async () => {
    const cloud = await startCloud();
    const { daemon, deviceId } = await pair(cloud, { recoveryFault: 'terminal:queued' });
    const offer = await cloud.rpc('enqueueOffer', { deviceId, instruction: 'cancel across restarts' }) as { taskId: string };
    await waitForFile(path.join(current!.daemonBase.controlDir, 'runtime-starts.jsonl'));
    await arm('terminal:queued');
    await finish(offer.taskId, 'late completion cannot erase cancellation');
    expect((await daemon.exited()).signal).toBe('SIGKILL');
    const [original] = journalRows('SELECT bytes, terminal_type, truth_state FROM journal_terminal');
    expect(original).toMatchObject({ terminal_type: 'complete', truth_state: 'pending' });
    await cloud.rpc('cancelTask', { taskId: offer.taskId, reason: 'operator cancellation race' });

    const second = new JsonChild(daemonBin, await writeConfig('daemon-repeat', { ...current!.daemonBase, recoveryFault: 'terminal:queued' }));
    current!.children.push(second);
    expect((await second.exited()).signal).toBe('SIGKILL');

    await fs.rm(path.join(current!.daemonBase.controlDir, 'terminal-queued.arm'));
    await startDaemon();
    await waitForAttempt(cloud, offer.taskId, 'cancelled');
    expect(starts()).toHaveLength(1);
    const terminal = decodeEnvelope(String(await cloud.rpc('readTerminalBody', { taskId: offer.taskId })));
    expect(terminal.type).toBe('task.complete');
    expect(await cloud.rpc('readTerminalBody', { taskId: offer.taskId })).toBe(original?.bytes);
    expect(journalRows('SELECT terminal_type, truth_state FROM journal_terminal')).toEqual([
      { terminal_type: 'complete', truth_state: 'confirmed' },
    ]);
  }, 30_000);

  it('redelivers an offer killed before local append commit and starts runtime exactly once', async () => {
    const cloud = await startCloud();
    const { daemon, deviceId } = await pair(cloud, { journalFault: 'append:before-commit' });
    const offer = await cloud.rpc('enqueueOffer', { deviceId, instruction: 'redeliver unacked offer' }) as { taskId: string };
    expect((await daemon.exited()).signal).toBe('SIGKILL');
    expect(starts()).toHaveLength(0);
    expect((await cloud.rpc('readCursor', { deviceId }) as { ackedSeq: number }).ackedSeq).toBe(0);

    await startDaemon();
    await waitForFile(path.join(current!.daemonBase.controlDir, 'runtime-starts.jsonl'));
    expect(starts()).toEqual([expect.objectContaining({ taskId: offer.taskId })]);
    await finish(offer.taskId, 'redelivered once');
    await waitForAttempt(cloud, offer.taskId, 'complete');
    expect(starts()).toHaveLength(1);
  }, 30_000);

  it('redelivers an offer killed after durable append but before execution and starts runtime exactly once', async () => {
    const cloud = await startCloud();
    const { daemon, deviceId } = await pair(cloud, { journalFault: 'append:after-commit' });
    const offer = await cloud.rpc('enqueueOffer', { deviceId, instruction: 'durable append precedes execution' }) as { taskId: string };
    expect((await daemon.exited()).signal).toBe('SIGKILL');
    expect(starts()).toHaveLength(0);
    expect((await cloud.rpc('readCursor', { deviceId }) as { ackedSeq: number }).ackedSeq).toBe(0);
    expect(journalRows('SELECT local_state FROM journal_task')).toEqual([{ local_state: 'received' }]);

    await startDaemon();
    await waitForFile(path.join(current!.daemonBase.controlDir, 'runtime-starts.jsonl'));
    expect(starts()).toEqual([expect.objectContaining({ taskId: offer.taskId })]);
    await finish(offer.taskId, 'redelivered from cloud authority');
    await waitForAttempt(cloud, offer.taskId, 'complete');
    expect(starts()).toHaveLength(1);
  }, 30_000);
});

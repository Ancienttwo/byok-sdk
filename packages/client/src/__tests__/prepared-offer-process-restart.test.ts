import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * A prepared preparation survives a REAL daemon process death.
 *
 * Every other test of this lane reconstructs the restart inside one process —
 * `prepared-offer-lane.test.ts` builds a second `InputPreparationStore` over
 * the same directory from code that still holds the first one's heap,
 * `input-preparation-store.test.ts` replays the log the same way. Those prove
 * the replay reads the log. They cannot prove that a process which was
 * SIGKILLed mid-Execution left a record, an artifact and a pin on disk that a
 * DIFFERENT process — a fresh address space, a fresh store, a fresh lane that
 * has opened nothing — reads back and acts on.
 *
 * G3b-C closed a CRITICAL of exactly that shape: the prepared-offer path never
 * opened the store, so a restarted daemon answered `preparation_not_found` for
 * a record sitting on its own disk. The fix is `inputPreparationLane.open`
 * (`create-daemon.ts`) plus the service's own once-only open latch. This file
 * is the process-level guard for it.
 *
 * Lifetime A seeds two counted records and is offered both. One Execution
 * reaches its terminal, which releases that record's pin; the other is still
 * holding its pin when the process is SIGKILLed. Lifetime B is then spawned
 * over the same store directory, and:
 *
 * - the RELEASED record is ADMITTED — no decline, one claim, one prepared
 *   start, off a record that exists only as bytes the dead process left behind;
 * - the HELD record's pin reads back byte for byte, and redelivering that task
 *   is refused `preparation_already_pinned` — the record is found, and single
 *   consumption still holds across the restart;
 * - a reference that was never stored is refused `preparation_not_found`, in
 *   the same process, so "found" and "not found" stay distinguishable answers.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/prepared-offer-restart-daemon.ts', import.meta.url));

/**
 * File-local wait budget. It widens the test's observation window only: nothing
 * under test reads it, and no timeout default, server default or CI setting is
 * touched by it. A child that has not answered in this long has failed, not
 * been rushed.
 */
const CHILD_RESPONSE_TIMEOUT_MS = 30_000;

const HELD_AGENT = 'agent-prepared-held';
const RELEASED_AGENT = 'agent-prepared-released';

interface JsonLine {
  readonly id?: number;
  readonly ready?: boolean;
  readonly pid?: number;
  readonly result?: unknown;
  readonly error?: string;
}

interface Seeded {
  readonly recordId: string;
  readonly requestDigest: string;
  readonly artifactDigest: string;
  readonly artifactPath: string;
}

interface OfferReport {
  readonly claims: number;
  readonly declines: readonly string[];
  readonly preparedStarts: number;
  readonly instructionStarts: number;
  readonly openCalls: number;
}

interface Pin {
  readonly taskId: string;
  readonly manifestDigest: string;
  readonly sealedAt: string;
}

/** One daemon lifetime, driven over NDJSON, killable by signal. */
class DaemonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly events: JsonLine[] = [];
  private readonly waiters: Array<() => void> = [];
  private nextId = 1;
  private buffer = '';
  stderr = '';

  constructor(configPath: string) {
    this.child = spawn('bun', [FIXTURE, configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderr += chunk; });
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim() === '') continue;
        this.events.push(JSON.parse(line) as JsonLine);
        for (const wake of this.waiters.splice(0)) wake();
      }
    });
  }

  private async waitFor(predicate: (event: JsonLine) => boolean): Promise<JsonLine> {
    const deadline = Date.now() + CHILD_RESPONSE_TIMEOUT_MS;
    for (;;) {
      const index = this.events.findIndex(predicate);
      if (index >= 0) return this.events.splice(index, 1)[0]!;
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`fixture exited before the expected event (${this.child.exitCode ?? this.child.signalCode}): ${this.stderr}`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for a fixture event: ${this.stderr}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 50));
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  async ready(): Promise<JsonLine> {
    return this.waitFor((event) => event.ready === true);
  }

  async rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
    const response = await this.waitFor((event) => event.id === id);
    if (response.error !== undefined) throw new Error(response.error);
    return response.result as T;
  }

  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }

  async exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return { code: this.child.exitCode, signal: this.child.signalCode };
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture did not exit: ${this.stderr}`)), CHILD_RESPONSE_TIMEOUT_MS);
      this.child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  }
}

let root: string;
let serverCommand: string;
let storeDir: string;
let runnerStoreDir: string;
let workspaceRoot: string;
let agentHomeDir: string;
const children: DaemonProcess[] = [];

async function spawnLifetime(name: string): Promise<DaemonProcess> {
  const configPath = path.join(root, `${name}.json`);
  await fs.writeFile(configPath, JSON.stringify({
    storeDir,
    runnerStoreDir,
    workspaceRoot,
    agentHomeDir,
    serverCommand,
  }), { mode: 0o600 });
  const child = new DaemonProcess(configPath);
  children.push(child);
  return child;
}

/** The OS's own answer, not the child's: a pid that no longer exists cannot be signalled. */
function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-prepared-restart-')));
  storeDir = path.join(root, 'preparation-store');
  runnerStoreDir = path.join(root, 'runner-store');
  workspaceRoot = path.join(root, 'workspace');
  agentHomeDir = path.join(root, 'agent-home');
  await fs.mkdir(storeDir, { recursive: true });
  serverCommand = path.join(root, 'teamserver');
  await fs.writeFile(serverCommand, '#!/bin/sh\nexec true\n', { mode: 0o755 });
});

afterEach(() => {
  for (const child of children) child.kill();
});

afterAll(async () => {
  for (const child of children.splice(0)) child.kill();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('a prepared preparation survives a real daemon process restart', () => {
  it('admits a released record and reads back a killed Execution\u2019s pin, while an unknown reference is refused', async () => {
    // --- lifetime A ----------------------------------------------------
    const first = await spawnLifetime('lifetime-a');
    const firstReady = await first.ready();

    // Two counted records, because the two properties under test are mutually
    // exclusive on one record: a record can either still be pinned when the
    // process dies, or have been released at a terminal before it did.
    // One Agent each: a canonical Agent home admits one mutable writer at a
    // time, and both Executions have to be live at once for the kill to catch
    // one of them holding a pin.
    const held = await first.rpc<Seeded>('seed', { requestId: 'prep-request-held', agentId: HELD_AGENT });
    const released = await first.rpc<Seeded>('seed', { requestId: 'prep-request-released', agentId: RELEASED_AGENT });
    expect(held.recordId).toMatch(/^[0-9a-f]{64}$/u);
    expect(released.recordId).not.toBe(held.recordId);

    const heldOffer = await first.rpc<OfferReport>('offer', {
      taskId: 'task-prepared-held',
      agentId: HELD_AGENT,
      reference: held.recordId,
      requestDigest: held.requestDigest,
      artifactDigest: held.artifactDigest,
      seq: 1,
    });
    expect(heldOffer.declines).toEqual([]);
    expect(heldOffer.claims).toBe(1);
    expect(heldOffer.preparedStarts).toBe(1);
    expect(heldOffer.instructionStarts).toBe(0);
    const pinByA = await first.rpc<Pin | null>('pin', { recordId: held.recordId });
    expect(pinByA?.taskId).toBe('task-prepared-held');
    expect(pinByA?.manifestDigest).toMatch(/^[0-9a-f]{64}$/u);

    const releasedOffer = await first.rpc<OfferReport>('offer', {
      taskId: 'task-prepared-released',
      agentId: RELEASED_AGENT,
      reference: released.recordId,
      requestDigest: released.requestDigest,
      artifactDigest: released.artifactDigest,
      seq: 2,
    });
    expect(releasedOffer.declines).toEqual([]);
    expect(releasedOffer.claims).toBe(1);
    expect(releasedOffer.preparedStarts).toBe(2);
    // The documented release rule, exercised rather than assumed: the pin is
    // released when the Execution reaches a terminal, and at no earlier point.
    expect(await first.rpc('finish', { sessionIndex: 1, recordId: released.recordId })).toEqual({ released: true });
    expect(await first.rpc<Pin | null>('pin', { recordId: released.recordId })).toBeNull();
    // ... and the record the other Execution still holds is untouched by it.
    expect(await first.rpc<Pin | null>('pin', { recordId: held.recordId })).toEqual(pinByA);

    // --- the kill ------------------------------------------------------
    // SIGKILL, so nothing in A runs again: no `stop()`, no store close, no
    // flush, no unpin. Whatever the next process sees is what was already on
    // disk when A died.
    const pid = firstReady.pid!;
    expect(processIsGone(pid)).toBe(false);
    first.kill();
    expect(await first.exited()).toEqual({ code: null, signal: 'SIGKILL' });
    await expect.poll(() => processIsGone(pid), { timeout: CHILD_RESPONSE_TIMEOUT_MS }).toBe(true);

    // --- lifetime B ----------------------------------------------------
    const second = await spawnLifetime('lifetime-b');
    const secondReady = await second.ready();
    expect(secondReady.pid).not.toBe(pid);

    // THE HEADLINE: a brand-new process, which has opened nothing, admits an
    // Execution against a record that exists only as bytes the killed process
    // left on disk. Before `inputPreparationLane.open` this declined
    // `preparation_not_found`.
    const admittedByB = await second.rpc<OfferReport>('offer', {
      taskId: 'task-prepared-after-restart',
      agentId: RELEASED_AGENT,
      reference: released.recordId,
      requestDigest: released.requestDigest,
      artifactDigest: released.artifactDigest,
      seq: 3,
    });
    expect(admittedByB.declines).toEqual([]);
    expect(admittedByB.claims).toBe(1);
    expect(admittedByB.preparedStarts).toBe(1);
    expect(admittedByB.instructionStarts).toBe(0);
    // One open authority for the whole lifetime, reached from the offer path.
    expect(admittedByB.openCalls).toBe(1);
    expect(await second.rpc<Pin | null>('pin', { recordId: released.recordId })).toMatchObject({
      taskId: 'task-prepared-after-restart',
    });

    // The artifact A retained is the one B launches from, byte path included.
    const artifactPath = await second.rpc<string | null>('artifactPath', { recordId: released.recordId });
    expect(artifactPath).toBe(released.artifactPath);
    await expect(fs.access(artifactPath!)).resolves.toBeUndefined();

    // --- the pin the killed Execution still held -----------------------
    // It survived the death of the process that wrote it, byte for byte.
    expect(await second.rpc<Pin | null>('pin', { recordId: held.recordId })).toEqual(pinByA);
    // And it is still SPENT. Redelivering that task after the restart reaches
    // `preparation_already_pinned`, not `preparation_not_found`: the record is
    // there, and single consumption is what stops a crashed Execution from
    // being re-run under accounting somebody already paid for. (The re-offer
    // seals a NEW manifest — the Agent-home lease id is fresh in this process —
    // so it can never be the same Execution the record was pinned by.)
    const redelivered = await second.rpc<OfferReport>('offer', {
      taskId: 'task-prepared-held',
      agentId: HELD_AGENT,
      reference: held.recordId,
      requestDigest: held.requestDigest,
      artifactDigest: held.artifactDigest,
      seq: 4,
    });
    expect(redelivered.claims).toBe(0);
    expect(redelivered.declines).toHaveLength(1);
    expect(redelivered.declines[0]!.split(':')[0]).toBe('preparation_already_pinned');
    expect(await second.rpc<Pin | null>('pin', { recordId: held.recordId })).toEqual(pinByA);

    // --- negative control, same process B ------------------------------
    // A reference this device never stored. Exact reason, not a substring
    // family: `preparation_not_found` is the answer a restarted daemon used to
    // give for a record it DID have, so the two must stay distinguishable.
    const unknown = await second.rpc<OfferReport>('offer', {
      taskId: 'task-prepared-never-stored',
      agentId: RELEASED_AGENT,
      reference: 'f'.repeat(64),
      requestDigest: released.requestDigest,
      artifactDigest: released.artifactDigest,
      seq: 5,
    });
    expect(unknown.claims).toBe(0);
    expect(unknown.declines).toHaveLength(1);
    expect(unknown.declines[0]!.split(':')[0]).toBe('preparation_not_found');
    // The two refusals started nothing: the count is still B's one admitted
    // prepared Execution.
    expect(unknown.preparedStarts).toBe(1);
    expect(unknown.instructionStarts).toBe(0);
  }, 120_000);
});

#!/usr/bin/env bun
// Client retention soak (#1105): drive real TaskRunner task lifecycles against the
// real retention registry/sweeper, sample every retention class, and write an
// archivable JSON report.
//
// The runtime is a fake adapter (the same in-process shape the client suite uses):
// it starts a session, stages one real submit_result outcome through
// TaskRunner.submitAgentResult, writes a Pi-shaped session file, and emits turn_end.
// Everything under test -- TaskRunner lifecycle, Agent-home leases, handoffs,
// result store, execution scratch, Pi session retention, RetentionRegistry,
// RetentionSweeper and every producer -- is the production implementation.
//
// Time is compressed: batches of tasks run at a simulated timestamp, the
// retention clock advances one interval per batch, and only files created by
// that batch get its timestamp. A 10k-task run with the defaults therefore spans
// 100 simulated days, exercising the 1h, 1d, 7d, 30d and 31d TTLs. Real elapsed
// time stays small; no filesystem timestamp is invented outside this harness.
//
// Usage:
//   bun scripts/soak/client-retention-soak.mjs --tasks 1000
//   bun scripts/soak/client-retention-soak.mjs --tasks 10000 --out soak-report.json
//
// The same tasks also drive the K4 Host ledger (`@byok-sdk/server/execution-core`,
// #1106): each task enqueues and settles one intent through the real transitions,
// and each batch's results are acknowledged and compacted. The ledger declares no
// total bound, so only what the code guarantees is asserted: `ignoredWakes` never
// exceeds IGNORED_WAKE_AUDIT_LIMIT, and `compact` empties every per-task table and
// shrinks the JSON body. The identity rows that remain (caller intent tombstones
// never expire) are measured and reported, never failed.
//
// Exit code is nonzero when a sweep reports a failure, a class scan is
// truncated, storage admission would be refused, a measured class exceeds
// its declared bound, or a guaranteed K4 ledger property breaks.

import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope, WIRE_ADDITIONS } from '../../packages/protocol/dist/index.js';
import { HostLedger, MIN_TOMBSTONE_RETENTION_MS } from '../../packages/server/src/execution-core/ledger.ts';
import { hash } from '../../packages/server/src/execution-core/model.ts';
import { auditIgnoredWake, IGNORED_WAKE_AUDIT_LIMIT } from '../../packages/server/src/execution-core/routines.ts';
import { enqueue, settle } from '../../packages/server/src/execution-core/transitions.ts';
import { AgentHomeManager } from '../../packages/client/src/agent-home.ts';
import { AgentEgressController } from '../../packages/client/src/daemon/agent-egress-controller.ts';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../../packages/client/src/daemon/agent-egress-policy.ts';
import { AgentSessionHandoffStore } from '../../packages/client/src/daemon/agent-session-handoff-store.ts';
import { ApprovalRegistry } from '../../packages/client/src/daemon/approvals.ts';
import { resolveStorageConfig } from '../../packages/client/src/daemon/retention/config.ts';
import { StoragePressure } from '../../packages/client/src/daemon/retention/pressure.ts';
import { createRetentionRegistry } from '../../packages/client/src/daemon/retention/producers.ts';
import { ScratchRoot } from '../../packages/client/src/daemon/retention/scratch.ts';
import { RetentionSweeper } from '../../packages/client/src/daemon/retention/sweeper.ts';
import { TaskRunner } from '../../packages/client/src/daemon/task-runner.ts';
import { buildRuntimeEnvironment } from '../../packages/client/src/runtime/environment.ts';
import { freezeRuntimeAdapterDescriptor } from '../../packages/client/src/types.ts';
import { AsyncQueue } from '../../packages/client/src/util/async-queue.ts';

const DAY_MS = 86_400_000;
const REPORT_SCHEMA = 'byok.client-retention-soak.v1';
const RESULT_CONTRACT = 'soak.retention.result.v1';
const RESULT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['ok'],
  properties: { ok: { type: 'boolean' } },
});
const PI_SESSION_REF = /^[A-Za-z0-9-]{1,128}$/u;
const ADVERTISED_CAPABILITIES = [...new Set(WIRE_ADDITIONS.flatMap(function (row) {
  return row.kind === 'envelope' && row.rule === 'gated' && row.advertisedBy === 'device' ? [row.capability] : [];
}))];

const K4_PER_TASK_TABLES = ['intents', 'executions', 'occurrences', 'slots', 'outbox', 'applied', 'application'];
const K4_TOMBSTONE_RETENTION_MS = Math.max(30 * DAY_MS, MIN_TOMBSTONE_RETENTION_MS);

/** One settled K4 intent per soak task, written through the production transitions in one ledger transaction. */
function k4SettleTask(ledger, agentRef, egressPolicy, key, failed, now) {
  ledger.transaction(state => {
    const intent = enqueue(state, ledger.tenant, { key, source: 'user', waitUntil: now + DAY_MS, execution: { deviceId: 'soak-device', payload: {
      session: { mode: 'fresh' }, instruction: 'retention soak task', runtime: 'pi', agentRef, egressPolicy,
      terminalProjection: { mode: 'result-document', contract: RESULT_CONTRACT, schema: RESULT_SCHEMA },
    } } });
    if (!failed) {
      state.executions[intent.taskId].terminal = { recordedAt: new Date(now).toISOString(), envelope: {
        v: 1, id: '00000000-0000-4000-8000-000000000001', ts: new Date(now).toISOString(), type: 'task.complete',
        task_id: intent.taskId, seq: 1, payload: { summary: '', sessionRef: 'soak', document: JSON.stringify({ ok: true }) },
      } };
      state.applied[intent.taskId] = true;
    }
    settle(state, intent, failed ? 'failed' : 'succeeded');
    // The Host has delivered the result projection; compaction refuses unacknowledged outbox rows.
    delete state.outbox['projection:' + hash('intent:' + key)];
    auditIgnoredWake(state, { dedupKey: 'soak-ignored:' + key }, now, 'unknown_key');
  });
}

function k4Measure(ledger) {
  const body = ledger.snapshot();
  const dump = ledger.dumpForSwitch();
  const tombstones = { intent: 0, application: 0, slot: 0, row: 0 };
  const tombstoneBytesByKind = { intent: 0, application: 0, slot: 0, row: 0 };
  for (const row of dump.tombstones) {
    tombstones[row.kind]++;
    tombstoneBytesByKind[row.kind] += Buffer.byteLength(JSON.stringify(row));
  }
  return {
    bodyBytes: Buffer.byteLength(JSON.stringify(body)),
    perTaskRows: Object.fromEntries(K4_PER_TASK_TABLES.map(table => [table, Object.keys(body[table]).length])),
    ignoredWakes: (body.ignoredWakes ?? []).length,
    tombstones, tombstoneBytesByKind,
  };
}

function k4Check(id, ok, detail) { return { id, status: ok ? 'pass' : 'fail', detail }; }

function parseArgs(argv) {
  const options = {
    tasks: 1000, batchSize: 100, intervalMs: DAY_MS, failEvery: 97,
    out: 'soak-report.json', summary: undefined, keep: false, verbose: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = function () {
      const value = argv[++index];
      if (value === undefined) throw new Error('missing value for ' + arg);
      return value;
    };
    switch (arg) {
      case '--tasks': options.tasks = Number(next()); break;
      case '--batch-size': options.batchSize = Number(next()); break;
      case '--interval-ms': options.intervalMs = Number(next()); break;
      case '--fail-every': options.failEvery = Number(next()); break;
      case '--out': options.out = next(); break;
      case '--summary': options.summary = next(); break;
      case '--keep': options.keep = true; break;
      case '--verbose': options.verbose = true; break;
      case '--help': case '-h':
        console.log('usage: bun scripts/soak/client-retention-soak.mjs [--tasks N] [--batch-size N] [--interval-ms N] [--fail-every N] [--out FILE] [--summary FILE] [--keep] [--verbose]');
        process.exit(0);
        break;
      default: throw new Error('unknown argument: ' + arg);
    }
  }
  for (const item of [
    ['tasks', options.tasks, 1], ['batch-size', options.batchSize, 1],
    ['interval-ms', options.intervalMs, 0], ['fail-every', options.failEvery, 0],
  ]) {
    if (!Number.isSafeInteger(item[1]) || item[1] < item[2]) throw new Error('--' + item[0] + ' must be an integer >= ' + item[2]);
  }
  return options;
}

/** The fake runtime's session: events are pushed by the driver, exactly like the client suite's stub. */
class SoakSession {
  #queue = new AsyncQueue();
  #closeGate;
  #releaseClose;
  sessionRef;
  constructor(sessionRef) { this.sessionRef = sessionRef; }
  get events() { return this.#queue; }
  emit(event) { this.#queue.push(event); }
  async steer() {}
  async followUp() {}
  async interrupt() {}
  async close() { await this.#closeGate; this.#queue.end(); }
  blockClose() {
    this.#closeGate = new Promise(resolve => { this.#releaseClose = resolve; });
    return () => { this.#closeGate = undefined; this.#releaseClose?.(); };
  }
  evidence() { return { decodeDropped: 0, unmappedFrames: 0, syntheticToolResults: 0 }; }
}

/** Fake runtime adapter: prepares a session and records start input (including the result helper env). */
class SoakRuntimeAdapter {
  startCalls = [];
  sessions = [];
  startError;
  #counter = 0;
  descriptor = freezeRuntimeAdapterDescriptor({
    id: 'pi', supportsDispatchSelection: true, requiresMcpToolsetToolObservation: false,
    capabilities: { steer: false, resume: true, approvalInteractive: false, mcpToolsets: true },
  });
  async runtimeEnvironment() { return buildRuntimeEnvironment({ base: 'allowlist' }); }
  async detect() { return { kind: 'available', version: '0.0.0-soak' }; }
  async prepare(input) {
    return { kind: 'prepared', operation: { start: startInput => this.#start(input, startInput) } };
  }
  async #start(prepared, input) {
    if (this.startError !== undefined) throw this.startError;
    const task = {
      instruction: input.instruction,
      ...(input.manifest.sessionRef === undefined ? {} : { sessionRef: input.manifest.sessionRef }),
    };
    this.startCalls.push({ task, input });
    this.#counter += 1;
    const sessionRef = input.manifest.sessionRef ?? 'soak-session-' + this.#counter;
    const session = new SoakSession(sessionRef);
    this.sessions.push(session);
    // A runtime writes its own output under the execution scratch's TMPDIR.
    // Keeping a real file there exercises exec-runtime instead of only its
    // empty directory, which the usage classifier does not count.
    if (typeof input.env?.TMPDIR === 'string') {
      await fs.writeFile(path.join(input.env.TMPDIR, 'output.log'), 'soak runtime output\n').catch(() => undefined);
    }
    void prepared;
    return session;
  }
}

/** Retry a few bounded passes, as production periodic sweeps eventually do after a truncated pass. */
async function sweepUntilQuiet(sweeper, trigger, maxPasses) {
  let last;
  for (let pass = 0; pass < maxPasses; pass++) {
    last = await sweeper.runPass(trigger);
    if (!last.truncated) break;
  }
  return last;
}

/** Stamp only files created by this batch; older files keep their batch timestamp so TTLs advance. */
async function stampNewFiles(directory, seen, when) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || seen.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    await fs.utimes(file, when, when);
    seen.add(entry.name);
  }
}

function classSnapshot(classes) {
  return classes.map(entry => ({
    classId: entry.classId,
    protected: entry.protected,
    measured: entry.measured,
    truncated: entry.truncated,
    bytes: entry.bytes,
    entries: entry.entries,
    oldestAgeMs: entry.oldestAgeMs,
  }));
}

function totals(classes) {
  return {
    bytes: classes.reduce((sum, entry) => sum + entry.bytes, 0),
    entries: classes.reduce((sum, entry) => sum + entry.entries, 0),
  };
}

function checkBounds(registry, classes) {
  const checks = [];
  for (const type of registry.classes) {
    const usage = classes.find(entry => entry.classId === type.id);
    if (usage === undefined) throw new Error('usage missing for ' + type.id);
    const bound = type.authority.bound;
    const base = { classId: type.id, bound, measured: usage.measured, truncated: usage.truncated,
      entries: usage.entries, bytes: usage.bytes, oldestAgeMs: usage.oldestAgeMs };
    if (bound.kind === 'exempt') {
      checks.push({ ...base, status: 'exempt', detail: bound.reason + ' (cleaned by ' + bound.cleanedBy + ': ' + bound.api + ')' });
      continue;
    }
    if (!usage.measured) {
      checks.push({ ...base, status: 'not-observed', detail: 'the TaskRunner lifecycle does not produce this class; its bound is declared and its usage is unmeasured here' });
      continue;
    }
    if (usage.truncated) {
      checks.push({ ...base, status: 'fail', detail: 'usage scan truncated: entries/bytes are lower bounds, so the declared bound cannot be checked' });
      continue;
    }
    if (bound.kind === 'ttl') {
      const ageOk = usage.entries === 0 || usage.oldestAgeMs === null || usage.oldestAgeMs <= bound.ttlMs;
      const countOk = bound.maxEntries === undefined || usage.entries <= bound.maxEntries;
      checks.push({
        ...base,
        status: ageOk && countOk ? 'pass' : 'fail',
        detail: ageOk && countOk
          ? 'oldest entry ' + (usage.oldestAgeMs ?? 0) + 'ms <= ttl ' + bound.ttlMs + 'ms' + (bound.maxEntries === undefined ? '' : '; ' + usage.entries + ' <= ' + bound.maxEntries + ' entries')
          : 'oldest entry ' + (usage.oldestAgeMs ?? 0) + 'ms / ttl ' + bound.ttlMs + 'ms, entries ' + usage.entries + (bound.maxEntries === undefined ? '' : ' / max ' + bound.maxEntries),
      });
      continue;
    }
    const countOk = usage.entries <= bound.maxEntries;
    checks.push({
      ...base,
      status: countOk ? 'pass' : 'fail',
      detail: countOk ? usage.entries + ' <= ' + bound.maxEntries + ' entries per ' + bound.per : usage.entries + ' > ' + bound.maxEntries + ' entries per ' + bound.per,
    });
  }
  return checks;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const started = performance.now();
  const base = process.platform === 'darwin' ? '/private/tmp' : process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const tempRoot = mkdtempSync(path.join(base, 'byok-retention-soak-'));
  const storeDir = path.join(tempRoot, 'store');
  const scratchDir = path.join(tempRoot, 'scratch');
  const homeRoot = path.join(tempRoot, 'home');
  const piSessionDir = path.join(tempRoot, 'pi-sessions');
  await fs.mkdir(storeDir, { recursive: true });
  await fs.mkdir(piSessionDir, { recursive: true });

  let simulatedNow = Date.now();
  const clock = () => new Date(simulatedNow);
  const config = resolveStorageConfig(storeDir, {
    scratchRoot: scratchDir,
    // A real Host budget: the soak proves admission stays normal, never that it
    // can be bypassed. The limits are generous because the run is short-lived.
    budget: { maxStoreBytes: 512 * 1024 * 1024, minFreeBytes: 64 * 1024 * 1024, softMinFreeBytes: 128 * 1024 * 1024,
      softBudgetRatio: 0.8, hardBudgetRatio: 0.9, ackCriticalReserveBytes: 8 * 1024 * 1024 },
  });
  const scratch = new ScratchRoot(config.scratchRoot, clock);
  await scratch.open(storeDir);
  const home = new AgentHomeManager({ hostStorageRoot: homeRoot });
  const handoffs = new AgentSessionHandoffStore();
  const agentRef = Object.freeze({ agentId: 'soak-agent', profileRevision: 'rev-1' });
  const registry = createRetentionRegistry({
    storeDir, scratch, config, clock, journal: () => undefined, identity: () => undefined,
    preparation: () => undefined, home, handoffs, piSessionDir,
  });
  const pressure = new StoragePressure(config.budget);
  const failures = [];
  const k4 = new HostLedger(path.join(tempRoot, 'host-ledger.sqlite'), 'soak-host');
  const k4Samples = [];
  const k4Checks = [];
  let k4Compacted = 0, k4Baseline;
  const sweeper = new RetentionSweeper({
    config, registry, pressure, clock, freeBytes: async () => 512 * 1024 * 1024 * 1024,
    jitter: (_sequence, interval) => interval,
    onFailure: (trigger, classId, code) => failures.push({ trigger, classId, code }),
  });
  const adapter = new SoakRuntimeAdapter();
  const sent = [];
  const runner = new TaskRunner({
    getIngressBudget: () => ({ activityMaxEvents: 50, activityMaxBytes: 65_536 }),
    advertisedCapabilities: () => ADVERTISED_CAPABILITIES,
    agentEgressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
    agentEgress: new AgentEgressController({ policy: DEFAULT_AGENT_EGRESS_POLICY }),
    scratchRoot: scratch,
    adapters: [adapter],
    agentHome: home,
    agentSessionHandoffs: handoffs,
    deviceId: 'soak-device',
    send: envelope => sent.push(envelope),
    blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('soak uploads no artifact'); } },
    approvalRegistry: new ApprovalRegistry(),
    storeDir,
    productId: 'retention-soak',
    tenantId: 'soak-tenant',
    agentResultMcpBin: { command: process.execPath, args: ['-e', ''] },
  });

  const binding = await home.prepare(agentRef);
  const canonicalHome = binding.resolution.canonicalHome;
  await binding.lease.release();
  const ledgerDir = path.join(canonicalHome, '.byok', 'runtime-sessions');
  const resultsDir = path.join(canonicalHome, '.byok', 'results');
  const seen = { ledger: new Set(), results: new Set(), pi: new Set(), home: new Set() };

  const waitFor = async (predicate, label, timeoutMs) => {
    const deadline = Date.now() + (timeoutMs ?? 30_000);
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for ' + label);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  };
  const terminalFor = taskId => sent.find(envelope => envelope.task_id === taskId
    && (envelope.type === 'task.complete' || envelope.type === 'task.fail' || envelope.type === 'task.cancelled' || envelope.type === 'task.decline'));

  const samples = [];
  const outcomes = { complete: 0, failed: 0, unexpected: 0 };
  let peakBytes = 0, peakEntries = 0, scanMsMin = Infinity, scanMsMax = 0;
  const running = { tasksCompleted: 0 };

  const recordSample = async (label, sweep) => {
    const startedScan = performance.now();
    const classes = await registry.measure();
    const scanDurationMs = performance.now() - startedScan;
    const totalsNow = totals(classes);
    peakBytes = Math.max(peakBytes, totalsNow.bytes);
    peakEntries = Math.max(peakEntries, totalsNow.entries);
    scanMsMin = Math.min(scanMsMin, scanDurationMs);
    scanMsMax = Math.max(scanMsMax, scanDurationMs);
    const guard = pressure.admissionGuard();
    const sample = {
      label,
      at: new Date().toISOString(),
      simulatedAt: new Date(simulatedNow).toISOString(),
      tasksCompleted: running.tasksCompleted,
      sweep: sweep === undefined ? undefined : {
        deleted: sweep.deleted, bytesReclaimed: sweep.bytesReclaimed, failures: sweep.failures,
        truncated: sweep.truncated, durationMs: sweep.durationMs,
      },
      pressure: pressure.state,
      admission: guard,
      scanDurationMs,
      totals: totalsNow,
      classes: classSnapshot(classes),
    };
    samples.push(sample);
    if (!guard.admit) failures.push({ trigger: 'sample', classId: 'admission', code: guard.reason });
    if (classes.some(entry => entry.truncated)) failures.push({ trigger: 'sample', classId: 'measurement', code: 'truncated' });
    if (options.verbose) {
      console.error('[soak] ' + label + ': ' + running.tasksCompleted + ' tasks, ' + totalsNow.entries + ' entries, '
        + totalsNow.bytes + ' bytes, sweep deleted ' + (sweep === undefined ? 0 : sweep.deleted) + ', scan ' + scanDurationMs.toFixed(1) + 'ms');
    }
  };

  k4Baseline = k4Measure(k4);
  // Baseline measurement and a startup pass, like a daemon boot.
  let sweep = await sweepUntilQuiet(sweeper, 'startup', 2);
  await recordSample('startup', sweep);

  const totalBatches = Math.ceil(options.tasks / options.batchSize);
  let nextTask = 0;
  for (let batch = 0; batch < totalBatches && nextTask < options.tasks; batch++) {
    const batchStart = simulatedNow;
    const batchCount = Math.min(options.batchSize, options.tasks - nextTask);
    const k4BatchKeys = [];
    for (let index = 0; index < batchCount; index++) {
      const taskNumber = nextTask++;
      const taskId = 'soak-task-' + taskNumber.toString().padStart(6, '0');
      const shouldFail = options.failEvery > 0 && taskNumber > 0 && taskNumber % options.failEvery === 0;
      adapter.startError = shouldFail ? new Error('soak deterministic runtime start failure') : undefined;
      const payload = {
        agentRef, instruction: 'retention soak task', runtime: 'pi',
        session: { mode: 'fresh' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        ...(shouldFail ? {} : { terminalProjection: { mode: 'result-document', contract: RESULT_CONTRACT, schema: RESULT_SCHEMA } }),
      };
      await runner.handleEnvelope(createEnvelope('task.offer', payload, { taskId, seq: 1 }));
      if (shouldFail) {
        await waitFor(() => terminalFor(taskId) !== undefined, 'failure terminal ' + taskId);
        const terminal = terminalFor(taskId);
        if (terminal?.type !== 'task.fail') {
          outcomes.unexpected++;
          throw new Error('expected task.fail for ' + taskId + ', got ' + (terminal === undefined ? 'none' : terminal.type));
        }
        outcomes.failed++;
      } else {
        // The start that just resolved holds the result-helper env; stage the
        // real staged-result record before the fake runtime ends its turn.
        const start = adapter.startCalls.at(-1);
        const contextToken = start === undefined ? undefined : start.input?.mcpServers?.byokagentresult?.env?.BYOK_AGENT_RESULT_CONTEXT;
        if (typeof contextToken !== 'string') {
          const decline = terminalFor(taskId);
          throw new Error('result helper was not injected for ' + taskId + (decline === undefined ? '' : ': ' + JSON.stringify(decline.payload)));
        }
        const staged = await runner.submitAgentResult({ contextToken, outcome: { ok: true } });
        if (staged.state !== 'staged') throw new Error('result staging failed for ' + taskId + ': ' + JSON.stringify(staged));
        const sessionRef = adapter.sessions.at(-1)?.sessionRef;
        if (sessionRef === undefined || !PI_SESSION_REF.test(sessionRef)) throw new Error('invalid session ref for ' + taskId);
        const stamp = new Date(batchStart).toISOString().replace(/[:.]/gu, '-');
        const file = path.join(piSessionDir, stamp + '_' + sessionRef + '.jsonl');
        await fs.writeFile(file, JSON.stringify({ type: 'session', id: sessionRef }) + '\n');
        await fs.utimes(file, new Date(batchStart), new Date(batchStart));
        seen.pi.add(path.basename(file));
        adapter.sessions.at(-1)?.emit({ type: 'turn_end' });
        await waitFor(() => terminalFor(taskId)?.type === 'task.complete', 'completion terminal ' + taskId);
        outcomes.complete++;
      }
      adapter.startError = undefined;
      await waitFor(() => runner.activeTaskCount === 0, 'active task cleanup ' + taskId);
      k4SettleTask(k4, agentRef, DEFAULT_AGENT_EGRESS_POLICY, taskId, shouldFail, batchStart);
      k4BatchKeys.push(taskId);
      running.tasksCompleted++;
    }
    // Stamp only files from this batch, so earlier batches keep their own
    // simulated age while the retention clock moves on.
    const when = new Date(batchStart);
    await stampNewFiles(ledgerDir, seen.ledger, when);
    await stampNewFiles(resultsDir, seen.results, when);
    await stampNewFiles(canonicalHome, seen.home, when);
    // The Host acknowledges the batch's results and compacts, as a product retention loop would.
    const k4Before = k4Measure(k4);
    const compaction = k4.compact({ acknowledgedIntentKeys: k4BatchKeys, now: batchStart, tombstoneRetentionMs: K4_TOMBSTONE_RETENTION_MS });
    k4Compacted += compaction.compactedIntents;
    const k4After = k4Measure(k4);
    k4Samples.push({ batch: batch + 1, tasksCompleted: running.tasksCompleted, compactedIntents: k4Compacted, compaction, before: k4Before, after: k4After });
    // Pre-sweep sample: what this batch actually accumulated before retention
    // has had a chance to run.
    await recordSample('batch-' + (batch + 1) + '-pre-sweep', undefined);
    simulatedNow = batchStart + options.intervalMs;
    sweep = await sweepUntilQuiet(sweeper, 'periodic', 8);
    await recordSample('batch-' + (batch + 1) + '-post-sweep', sweep);
  }

  // Final settling: a daemon would keep sweeping periodically. Run bounded
  // passes until nothing has expired or the pass budget is exhausted.
  simulatedNow += options.intervalMs;
  sweep = await sweepUntilQuiet(sweeper, 'periodic', 32);
  await recordSample('final', sweep);
  const finalClasses = samples.at(-1).classes;
  const boundChecks = checkBounds(registry, finalClasses);
  const boundFailures = boundChecks.filter(check => check.status === 'fail');

  const k4Final = k4Samples.at(-1);
  const k4PeakBody = Math.max(...k4Samples.map(sample => sample.before.bodyBytes));
  const k4MaxIgnored = Math.max(...k4Samples.map(sample => Math.max(sample.before.ignoredWakes, sample.after.ignoredWakes)));
  k4Checks.push(k4Check('ignored-wakes', k4MaxIgnored <= IGNORED_WAKE_AUDIT_LIMIT,
    'max ' + k4MaxIgnored + ' <= ' + IGNORED_WAKE_AUDIT_LIMIT + ' entries'));
  k4Checks.push(k4Check('compact-empties-per-task-tables', k4Samples.every(sample => Object.values(sample.after.perTaskRows).every(count => count === 0)),
    'intents/executions/occurrences/slots/outbox/applied/application are empty after every compact'));
  k4Checks.push(k4Check('compact-shrinks-body', k4Samples.every(sample => sample.compaction.afterBytes < sample.compaction.beforeBytes),
    'peak body ' + k4PeakBody + ' bytes, post-compact body ' + k4Final.after.bodyBytes + ' bytes (empty ledger ' + k4Baseline.bodyBytes + ')'));
  // Known limit, measured and not asserted: caller intent tombstones never expire (docs/host-local-storage-layout.md#k4-host-ledger).
  const permanentBytes = k4Final.after.tombstoneBytesByKind.intent;
  const k4Growth = {
    compactedIntents: k4Compacted,
    tombstones: k4Final.after.tombstones,
    tombstoneBytesByKind: k4Final.after.tombstoneBytesByKind,
    // Intent tombstones have a null expiry; application and slot tombstones expire with the compaction window.
    permanentTombstoneBytesPerCompactedIntent: k4Compacted === 0 ? 0 : permanentBytes / k4Compacted,
  };
  k4.close();
  const failuresTotal = failures.length + boundFailures.length + k4Checks.filter(check => check.status === 'fail').length;
  const finishedAt = new Date();
  const durationMs = performance.now() - started;
  const report = {
    schema: REPORT_SCHEMA,
    issue: 1105,
    generatedAt: finishedAt.toISOString(),
    command: {
      tasks: options.tasks, batchSize: options.batchSize, intervalMs: options.intervalMs,
      failEvery: options.failEvery, simulatedDays: (options.intervalMs / DAY_MS) * Math.ceil(options.tasks / options.batchSize),
    },
    environment: {
      platform: process.platform, arch: process.arch, node: process.version,
      bun: typeof Bun === 'undefined' ? undefined : Bun.version,
      cwd: process.cwd(), tempRoot,
    },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    tasksPerSecond: running.tasksCompleted / (durationMs / 1000),
    outcomes,
    bounds: Object.fromEntries(registry.classes.map(entry => [entry.id, entry.authority.bound])),
    samples,
    final: samples.at(-1),
    boundChecks,
    k4Ledger: { checks: k4Checks, growth: k4Growth, baseline: k4Baseline, samples: k4Samples },
    peak: { bytes: peakBytes, entries: peakEntries, scanMs: { min: Number.isFinite(scanMsMin) ? scanMsMin : null, max: scanMsMax } },
    sweepFailures: failures,
    passed: failuresTotal === 0 && outcomes.unexpected === 0,
    failures: failuresTotal,
  };

  const outPath = path.resolve(options.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2) + '\n');

  const summaryLines = [
    '# Client retention soak (#1105)',
    '',
    '- Tasks: ' + report.command.tasks + ' (' + outcomes.complete + ' complete, ' + outcomes.failed + ' deterministic failures)',
    '- Simulated span: ' + report.command.simulatedDays + ' days (' + report.command.batchSize + ' tasks/batch, ' + (report.command.intervalMs / 60_000).toFixed(0) + ' min/batch)',
    '- Duration: ' + (durationMs / 1000).toFixed(1) + 's (' + report.tasksPerSecond.toFixed(1) + ' tasks/s)',
    '- Peak usage: ' + peakBytes + ' bytes / ' + peakEntries + ' entries; scan ' + scanMsMin.toFixed(1) + '-' + scanMsMax.toFixed(1) + 'ms',
    '- Final usage: ' + report.final.totals.bytes + ' bytes / ' + report.final.totals.entries + ' entries',
    '- Bound checks: ' + boundChecks.filter(check => check.status === 'pass').length + ' pass, ' + boundFailures.length + ' fail, '
      + boundChecks.filter(check => check.status === 'exempt').length + ' exempt, '
      + boundChecks.filter(check => check.status === 'not-observed').length + ' not observed',
    '- Sweep failures: ' + failures.length,
    '- K4 ledger: ' + k4Checks.filter(check => check.status === 'pass').length + ' pass, ' + k4Checks.filter(check => check.status === 'fail').length + ' fail; '
      + k4Compacted + ' intents compacted; permanent identity growth ' + k4Growth.permanentTombstoneBytesPerCompactedIntent.toFixed(1)
      + ' B/intent as serialized rows, before SQLite page and index overhead (' + k4Growth.tombstones.intent + ' intent, '
      + k4Growth.tombstones.application + ' application, ' + k4Growth.tombstones.slot + ' slot rows)',
    '- Result: ' + (report.passed ? 'PASS' : 'FAIL'),
    '',
    '| Class | Status | Entries | Bytes | Oldest age (ms) | Bound |',
    '| --- | --- | ---: | ---: | ---: | --- |',
    ...boundChecks.map(check => '| ' + check.classId + ' | ' + check.status + ' | ' + check.entries + ' | ' + check.bytes + ' | ' + (check.oldestAgeMs ?? '') + ' | ' + check.bound.kind + ' |'),
    '',
    '| K4 ledger check | Status | Detail |',
    '| --- | --- | --- |',
    ...k4Checks.map(check => '| ' + check.id + ' | ' + check.status + ' | ' + check.detail + ' |'),
    '',
  ];
  const summary = summaryLines.join('\n');
  if (options.summary !== undefined) {
    const summaryPath = path.resolve(options.summary);
    await fs.mkdir(path.dirname(summaryPath), { recursive: true });
    await fs.writeFile(summaryPath, summary);
  }
  console.log(summary);
  console.log('[soak] report: ' + outPath);

  await runner.shutdownActiveTasks('soak complete').catch(() => undefined);
  await sweeper.stop().catch(() => undefined);
  if (!options.keep) await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  else console.log('[soak] kept temp root: ' + tempRoot);
  process.exit(report.passed ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

// The #610 measurement harness: one embedded Host (`@byok-sdk/server`), one
// paired daemon with one runtime adapter, and the real `submit_result`
// helper. It captures what the Host received at its HTTP boundary.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import {
  createDaemonWithAdapters, type AgentEgressPolicy, type Daemon, type RuntimeAdapter, type RuntimeAdapterPrepareInput,
  type MessageDraftDelta, type RuntimeAdapterPrepareResult, type RuntimeOperationStartInput, type Session,
} from '@byok-sdk/client';
import { BYOK_EVENTS_PATH, BYOK_MESSAGES_PATH, type AgentEvent, type DispatchSelection, type OfferAdmissionTimings } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer } from '@byok-sdk/server';
import { InMemoryDeviceCredentialStore } from '../../../../scripts/testing/device-credentials.mjs';
import { CORPUS, CORPUS_REVISION, corpusCase, preflightCorpus } from './corpus';
import { resultDigest } from './digest';
import {
  calibrateLabel, classifyTrial, UNCONFIRMED_PREDICATE,
  type CallPredicate, type ObservedEvent, type StagedRecord, type TerminalObservation, type TrialObservation,
} from './evidence';
import { redact, type CalibrationResult, type NotStartedRow, type PlannedTrial, type RunManifest, type TrialRecord, type TrialTerminal } from './records';
import { renderSummaryMarkdown, summarizeRun } from './summary';

export const PRODUCT_ID = 'byok-submit-result-measurement';
/** Explicit daemon limits, so the cell records known values. They equal the SDK defaults. */
export const DAEMON_LIMITS = Object.freeze({ maxInlineEventBytes: 64 * 1024, maxTaskOutputBytes: 64 * 1024 * 1024 });
export const EGRESS_POLICY: AgentEgressPolicy = Object.freeze({
  policyRevision: 'submit-result-measurement-v1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
}) as AgentEgressPolicy;
/** How long the runner waits for a terminal after it cancels a task at the deadline. */
const CANCEL_GRACE_MS = 30_000;
const IDLE_WAIT_MS = 60_000;

export const MEASURED_RUNTIMES = ['pi', 'claude', 'codex', 'grok'] as const;
export type MeasuredRuntime = typeof MEASURED_RUNTIMES[number];

export interface PlanInput { readonly rounds: number; readonly caseIds: readonly string[]; readonly calibrate: boolean }

/** The calibration case is fixed, whatever cases a cell counts. */
export const CALIBRATION_CASE = 'C01-small';

/** C01–C06 order for each round, after one uncounted calibration trial. */
export function planTrials(input: PlanInput): PlannedTrial[] {
  const trials: PlannedTrial[] = [];
  if (input.calibrate) trials.push({ trialId: 'calibration-1', caseId: CALIBRATION_CASE, round: 0, counted: false });
  for (let round = 1; round <= input.rounds; round++) {
    for (const caseId of input.caseIds) trials.push({ trialId: `r${String(round).padStart(2, '0')}-${caseId}`, caseId, round, counted: true });
  }
  return trials;
}

/**
 * Records every AgentEvent a runtime adapter emits, before the daemon batches
 * it. For an Agent-bound task the daemon sends each `task.progress` batch on
 * the latest-value lane, which keeps only the last event of the batch, so the
 * Host does not receive every `tool_use`/`tool_result`. This pass-through
 * wrapper uses the public RuntimeAdapter contract and changes nothing the
 * daemon sees.
 */
export class AdapterEventRecorder {
  private readonly byTask = new Map<string, ObservedEvent[]>();

  events(taskId: string): readonly ObservedEvent[] { return this.byTask.get(taskId) ?? []; }

  wrap(adapter: RuntimeAdapter): RuntimeAdapter {
    const record = (taskId: string, event: unknown) => {
      const list = this.byTask.get(taskId) ?? [];
      list.push({ at: new Date().toISOString(), event: event as Record<string, unknown> });
      this.byTask.set(taskId, list);
    };
    const observeSession = (session: Session, taskId: string): Session => {
      const events: AsyncIterable<AgentEvent | MessageDraftDelta> = {
        [Symbol.asyncIterator]() {
          const iterator = session.events[Symbol.asyncIterator]();
          return {
            // Draft deltas are display-only text, not AgentEvents.
            next: async () => { const step = await iterator.next(); if (!step.done && step.value.type !== 'message_draft_delta') record(taskId, step.value); return step; },
            ...(iterator.return ? { return: (value?: unknown) => iterator.return!(value) } : {}),
            ...(iterator.throw ? { throw: (error?: unknown) => iterator.throw!(error) } : {}),
          };
        },
      };
      return passThrough(session, { events });
    };
    const prepare = async (input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> => {
      const result = await adapter.prepare(input);
      if (result.kind !== 'prepared') return result;
      const operation = result.operation;
      const start = async (startInput: RuntimeOperationStartInput) => observeSession(await operation.start(startInput), startInput.manifest.taskId);
      return { ...result, operation: passThrough(operation, { start }) };
    };
    return passThrough(adapter, { prepare });
  }
}

/** A view of `target` with some members replaced; every other member, bound to `target`. */
function passThrough<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(object, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property as keyof T];
      const value = Reflect.get(object, property, object) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    },
  });
}

interface Captured { readonly at: string; readonly envelope: { readonly id?: string; readonly type: string; readonly task_id?: string; readonly payload: Record<string, unknown> } }

/** Records every envelope the Host accepted on `POST /byok/messages` (claim, start, terminal), and the advertised activity budget. */
class HostTap {
  readonly captured: Captured[] = [];
  activityMaxBytes: number | null = null;
  private readonly ids = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly server: ByokServer) {}

  readonly fetch = async (request: Request, ...rest: unknown[]): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    const copy = request.method === 'POST' && pathname === BYOK_MESSAGES_PATH ? request.clone() : undefined;
    const response = await (this.server.hono.fetch as (request: Request, ...rest: unknown[]) => Response | Promise<Response>)(request, ...rest);
    if (copy && response.ok) this.record(await copy.json().catch(() => undefined));
    // Both answers advertise the activity ingress: the accepted conn.hello answer and every events page.
    if (response.ok && this.activityMaxBytes === null && (copy || (request.method === 'GET' && pathname === BYOK_EVENTS_PATH))) {
      const body = await response.clone().json().catch(() => undefined) as { ingress?: { activityMaxBytes?: unknown } } | undefined;
      if (typeof body?.ingress?.activityMaxBytes === 'number') this.activityMaxBytes = body.ingress.activityMaxBytes;
    }
    return response;
  };

  private record(body: unknown): void {
    const messages = (body as { messages?: unknown } | undefined)?.messages;
    if (!Array.isArray(messages)) return;
    const at = new Date().toISOString();
    for (const envelope of messages as Captured['envelope'][]) {
      if (envelope === null || typeof envelope !== 'object' || typeof envelope.type !== 'string') continue;
      if (typeof envelope.id === 'string') { if (this.ids.has(envelope.id)) continue; this.ids.add(envelope.id); }
      this.captured.push({ at, envelope });
    }
    for (const listener of [...this.listeners]) listener();
  }

  forTask(taskId: string): Captured[] { return this.captured.filter(entry => entry.envelope.task_id === taskId); }

  /** Resolve true once `predicate` holds, or false at `deadline` (epoch ms) or on abort. */
  waitFor(predicate: () => boolean, deadline: number, signal?: AbortSignal): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (value: boolean) => { clearTimeout(timer); this.listeners.delete(check); signal?.removeEventListener('abort', aborted); resolve(value); };
      const check = () => { if (predicate()) finish(true); };
      const aborted = () => finish(predicate());
      const timer = setTimeout(() => finish(predicate()), Math.max(0, deadline - Date.now()));
      this.listeners.add(check);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }
}

export interface RunCellOptions {
  readonly runId: string;
  readonly cellId: string;
  readonly mode: 'execute' | 'synthetic';
  /** `grok` is not a wire runtime id: its offers name the `grok` harness instead. */
  readonly runtime: MeasuredRuntime;
  /** Sent on every offer when the runtime accepts it (Claude, Codex, Pi with a BYOK launcher). */
  readonly dispatchSelection?: DispatchSelection;
  readonly adapters: () => RuntimeAdapter[];
  readonly outDir: string;
  /** Scratch root for the Host, the daemon store and the Agent homes. */
  readonly workRoot: string;
  readonly rounds: number;
  readonly caseIds?: readonly string[];
  readonly deadlineMs: number;
  readonly maxTrials: number;
  readonly maxSpend?: string | null;
  readonly capacityReasons: readonly string[];
  readonly calibrate: boolean;
  readonly authorization: string | null;
  /** Operator-declared cell facts (model, settings, account tier label, model token limits, ...). */
  readonly cell: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
}

export interface RunCellResult {
  readonly manifest: RunManifest;
  readonly trials: readonly TrialRecord[];
  readonly notStarted: readonly NotStartedRow[];
  readonly files: readonly string[];
}

function corpusManifest() {
  return {
    revision: CORPUS_REVISION,
    preflight: preflightCorpus(),
    cases: CORPUS.map(entry => ({ id: entry.id, hashes: entry.hashes, bytes: entry.bytes, targetDigest: entry.targetDigest })),
  };
}

/** The manifest of a run that has not started: the dry-run output. */
export function plannedManifest(options: Omit<RunCellOptions, 'adapters' | 'outDir' | 'workRoot' | 'mode'> & { mode: RunManifest['mode'] }): RunManifest {
  const caseIds = options.caseIds ?? CORPUS.map(entry => entry.id);
  const plan = planTrials({ rounds: options.rounds, caseIds, calibrate: options.calibrate });
  const counted = plan.filter(trial => trial.counted).length;
  const calibration = plan.length - counted;
  return {
    schema: 'byok.submit-result-measurement.manifest.v1', runId: options.runId, cellId: options.cellId,
    mode: options.mode, synthetic: options.mode !== 'execute', authorization: options.authorization,
    // Generated facts come last: operator facts can never replace them.
    cell: { ...options.cell, runtime: options.runtime, dispatchSelection: options.dispatchSelection ?? null, ...cellFacts(), sdkBuild: sdkBuild() },
    corpus: corpusManifest(),
    plan: { rounds: options.rounds, order: caseIds, plannedTrials: counted, calibrationTrials: calibration, runtimeTasks: calibration + Math.min(counted, options.maxTrials) },
    deadlineMs: options.deadlineMs, budget: { maxTrials: options.maxTrials, maxSpend: options.maxSpend ?? null },
    capacityReasons: options.capacityReasons, predicate: UNCONFIRMED_PREDICATE, calibration: null,
    startedAt: null, endedAt: null, completion: 'planned', startedTrials: 0, notStartedTrials: 0,
  };
}

/**
 * Cell keys the runner sets itself. An operator `--cell` fact may not use them.
 * `model` comes from `--model`; the last two come from the live Host.
 */
export const RESERVED_CELL_KEYS: readonly string[] = Object.freeze([
  'model', 'runtime', 'dispatchSelection', 'platform', 'osRelease', 'arch', 'node', 'bun', 'transport', 'concurrency',
  'agentMemory', 'requiredToolsets', 'messageEgress', 'replyDelivery', 'eventSource', 'daemonLimits', 'egressPolicy',
  'sdkBuild', 'observedRuntimes', 'activityMaxBytes',
]);

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/**
 * Every SDK package the runner loads at runtime: the closure of `@byok-sdk/*`
 * imports in the built dist of client, server and protocol. A test recomputes
 * this closure from the dist files.
 */
export const SDK_RUNTIME_PACKAGES = ['client', 'server', 'protocol', 'core', 'cloud'] as const;

/** Hex SHA-256 over every built file in `dist` except type declarations and source maps; `null` without a dist. */
export function distTreeSha256(distRoot: string): string | null {
  if (!existsSync(distRoot)) return null;
  const files = (readdirSync(distRoot, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && !/\.(?:map|d\.[cm]?ts)$/.test(entry.name))
    .map(entry => path.join(entry.parentPath, entry.name))
    .map(file => ({ file, relative: path.relative(distRoot, file).split(path.sep).join('/') }))
    .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  const tree = createHash('sha256');
  for (const { file, relative } of files) tree.update(`${relative}\0${createHash('sha256').update(readFileSync(file)).digest('hex')}\n`);
  return tree.digest('hex');
}

/**
 * The SDK build that runs the cell: the checkout commit, whether tracked files
 * differ from it, and each runtime package version with a hash of its whole
 * built dist (entries, bins and helpers). The dist hash identifies the bytes
 * even when the build is older than the checkout. Unavailable values are `null`.
 */
export function sdkBuild(): Record<string, unknown> {
  const git = (args: string[]) => {
    try { return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
  };
  const commit = git(['rev-parse', 'HEAD']);
  const status = commit === null ? null : git(['status', '--porcelain', '--untracked-files=no']);
  const packages = Object.fromEntries(SDK_RUNTIME_PACKAGES.map(name => {
    const root = path.join(REPO_ROOT, 'packages', name);
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string; version: string };
    return [manifest.name, { version: manifest.version, distSha256: distTreeSha256(path.join(root, 'dist')) }];
  }));
  return { commit, dirty: status === null ? null : status.length > 0, packages };
}

function cellFacts(): Record<string, unknown> {
  return {
    platform: process.platform, osRelease: os.release(), arch: process.arch,
    node: process.versions.node, bun: process.versions.bun ?? null,
    transport: 'long-poll', concurrency: 1, agentMemory: 'none', requiredToolsets: [],
    messageEgress: null, replyDelivery: 'not_configured',
    // Source 1 is read at the adapter boundary: the latest-value lane drops events from Agent task.progress batches.
    eventSource: 'adapter-boundary',
    daemonLimits: DAEMON_LIMITS, egressPolicy: EGRESS_POLICY,
  };
}

async function findStagedRecord(root: string, taskId: string): Promise<StagedRecord | null | 'unreadable'> {
  const name = `result-${createHash('sha256').update(taskId, 'utf8').digest('hex')}.json`;
  const search = async (directory: string, depth: number): Promise<string | undefined> => {
    if (depth > 8) return undefined;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === name && path.basename(directory) === 'results') return full;
      if (entry.isDirectory()) { const found = await search(full, depth + 1); if (found) return found; }
    }
    return undefined;
  };
  const file = await search(root, 0);
  if (!file) return null;
  try {
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    if (record.taskId !== taskId || !Object.hasOwn(record, 'outcome') || typeof record.contentHash !== 'string'
      || typeof record.byteCount !== 'number' || typeof record.receiptId !== 'string' || typeof record.createdAt !== 'string') return 'unreadable';
    return { outcome: record.outcome, contentHash: record.contentHash, byteCount: record.byteCount, receiptId: record.receiptId, createdAt: record.createdAt };
  } catch { return 'unreadable'; }
}

interface Host { server: ByokServer; tap: HostTap; recorder: AdapterEventRecorder; daemon: Daemon; deviceId: string; homes: string; close(): Promise<void> }

async function openHost(options: RunCellOptions): Promise<Host> {
  const server = createByokServer({ productId: PRODUCT_ID, storage: { kind: 'memory' }, wake: { consume: async () => {} } });
  const tap = new HostTap(server);
  const http = serve({ fetch: tap.fetch, port: 0, hostname: '127.0.0.1' });
  if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
  const { port } = http.address() as AddressInfo;
  const homes = path.join(options.workRoot, 'homes');
  const recorder = new AdapterEventRecorder();
  const daemon = createDaemonWithAdapters({
    productId: PRODUCT_ID, productName: 'submit_result measurement', localAgentRelease: { version: '0.0.0-measurement' },
    serverUrl: `http://127.0.0.1:${port}`, storeDir: path.join(options.workRoot, 'sdk'),
    agentHome: { hostStorageRoot: homes }, agentEgress: { policy: EGRESS_POLICY }, ...DAEMON_LIMITS,
  }, options.adapters().map(adapter => recorder.wrap(adapter)), { deviceCredentials: new InMemoryDeviceCredentialStore() });
  const close = async () => {
    await daemon.stop().catch(() => {});
    await server.close().catch(() => {});
    await new Promise<void>(resolve => { http.close(() => resolve()); if ('closeAllConnections' in http) http.closeAllConnections(); });
  };
  try {
    const pairing = await server.pairing.createPairingCode({ productId: PRODUCT_ID });
    const { deviceId } = await daemon.pair(pairing.code);
    await daemon.start();
    const ready = Date.now() + 30_000;
    const open = () => { const lifecycle = daemon.status().lifecycle; return lifecycle.phase === 'running' && 'connection' in lifecycle && lifecycle.connection === 'open'; };
    while (!open()) {
      if (Date.now() > ready) throw new Error('daemon did not report an open connection within 30 seconds');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { server, tap, recorder, daemon, deviceId, homes, close };
  } catch (error) { await close(); throw error; }
}

type TrialOutcome =
  | { readonly kind: 'started'; readonly record: TrialRecord; readonly events: readonly ObservedEvent[] }
  | { readonly kind: 'not_started'; readonly row: NotStartedRow };

async function runTrial(host: Host, options: RunCellOptions, planned: PlannedTrial, predicate: CallPredicate): Promise<TrialOutcome> {
  const entry = corpusCase(planned.caseId);
  const taskId = `m610-${options.runId}-${planned.trialId}`;
  const agentId = `m610-${createHash('sha256').update(taskId).digest('hex').slice(0, 16)}`;
  const offeredAt = new Date().toISOString();
  const deadline = Date.now() + options.deadlineMs;
  const base = { runId: options.runId, cellId: options.cellId, trialId: planned.trialId, caseId: planned.caseId, round: planned.round, taskId };
  const notStarted = (stage: NotStartedRow['stage'], reason: string | null, code: string | null = null, admission: OfferAdmissionTimings | null = null): TrialOutcome =>
    ({ kind: 'not_started', row: { ...base, stage, reason, code, admission, at: new Date().toISOString() } });
  try {
    await host.server.executions.submit({
      taskId, deviceId: host.deviceId,
      payload: {
        session: { mode: 'fresh' }, instruction: entry.instruction, ...(options.runtime === 'grok' ? { harnessId: 'grok' } : { runtime: options.runtime }), agentRef: { agentId, profileRevision: '1' }, agentMemory: 'none',
        ...(options.dispatchSelection ? { dispatchSelection: options.dispatchSelection } : {}),
        terminalProjection: { mode: 'result-document', contract: `${CORPUS_REVISION}.${planned.caseId.toLowerCase()}`, schema: entry.schema as never },
        egressPolicy: EGRESS_POLICY,
      },
    });
  } catch (error) {
    return notStarted('submit', error instanceof Error ? error.message : String(error), (error as { code?: string }).code ?? null);
  }
  const find = (type: string) => host.tap.forTask(taskId).find(item => item.envelope.type === type);
  const terminalOf = () => host.tap.forTask(taskId).find(item => ['task.complete', 'task.fail', 'task.cancelled'].includes(item.envelope.type));
  const settled = () => terminalOf() !== undefined || find('task.decline') !== undefined;
  await host.tap.waitFor(settled, deadline, options.signal);
  const operatorCancelled = options.signal?.aborted === true && !settled();
  const deadlineExpired = !operatorCancelled && !settled();
  if (!settled()) {
    await host.server.tasks.cancel(taskId, operatorCancelled ? 'operator cancelled the measurement' : 'measurement deadline').catch(() => {});
    await host.tap.waitFor(settled, Date.now() + CANCEL_GRACE_MS);
  }
  const claim = find('task.claim');
  const decline = find('task.decline');
  if (!claim) {
    await waitForIdle(host);
    if (decline) {
      const { reason, code, admission } = decline.envelope.payload as { reason?: unknown; code?: string; admission?: OfferAdmissionTimings };
      return notStarted('decline', String(reason ?? ''), code ?? null, admission ?? null);
    }
    return terminalOf() ? notStarted('terminal_before_claim', String(terminalOf()!.envelope.payload.reason ?? '')) : notStarted('unclaimed', 'no claim before the deadline');
  }
  const terminalEntry = terminalOf();
  const afterDeadline = terminalEntry !== undefined && (deadlineExpired || operatorCancelled);
  const terminal: TerminalObservation | null = terminalEntry ? {
    status: terminalEntry.envelope.type as TerminalObservation['status'], at: terminalEntry.at,
    reason: typeof terminalEntry.envelope.payload.reason === 'string' ? terminalEntry.envelope.payload.reason : null,
    hasDocument: Object.hasOwn(terminalEntry.envelope.payload, 'document'), document: terminalEntry.envelope.payload.document,
  } : null;
  await waitForIdle(host);
  const events = host.recorder.events(taskId);
  const observation: TrialObservation = {
    events, terminal: afterDeadline ? null : terminal, staged: await findStagedRecord(host.homes, taskId),
    deadlineExpired, operatorCancelled, infrastructure: daemonFailure(host),
  };
  const classified = classifyTrial(observation, { corpusCase: entry, predicate, capacityReasons: options.capacityReasons });
  const startedAt = find('task.started')?.at ?? claim.at;
  const usage = events.filter(item => item.event.type === 'usage').map(item => item.event);
  return {
    kind: 'started', events,
    record: {
      ...base, retryOf: null, offeredAt, claimedAt: claim.at,
      admission: (claim.envelope.payload as { admission?: OfferAdmissionTimings }).admission ?? null, startedAt,
      finishedAt: terminal?.at ?? null,
      elapsedMs: terminal && !afterDeadline ? Date.parse(terminal.at) - Date.parse(startedAt) : null,
      deadlineMs: options.deadlineMs, submissions: classified.submissions, submissionSeen: classified.submissionSeen,
      terminal: trialTerminal(terminal, afterDeadline),
      category: classified.category, cause: classified.cause, exactTarget: classified.exactTarget, firstCallValid: classified.firstCallValid,
      replyDelivery: 'not_configured', replyDisposition: null, usage: usage.length > 0 ? usage : null,
      evidenceRef: `events/${planned.trialId}.json`,
    },
  };
}

/**
 * The recorded terminal. Its digest comes from the observed terminal itself, so
 * a terminal that arrives in the cancellation grace keeps its digest although
 * classification treats it as absent.
 */
export function trialTerminal(terminal: TerminalObservation | null, afterDeadline: boolean): TrialTerminal | null {
  if (terminal === null) return null;
  const outcomeDigest = terminal.status === 'task.complete' && terminal.hasDocument ? resultDigest(terminal.document) : null;
  return { status: terminal.status, at: terminal.at, reason: terminal.reason, errorCode: null, outcomeDigest, afterDeadline };
}

/** A halted, crashed or stopped daemon is a harness-observed infrastructure failure. A reconnect is not. */
function daemonFailure(host: Host): { stage: string; code: string } | null {
  const lifecycle = host.daemon.status().lifecycle;
  if (lifecycle.phase === 'running') return null;
  return { stage: 'daemon', code: lifecycle.phase === 'halted' ? `halted:${lifecycle.reason}` : lifecycle.phase };
}

/** One task at a time: wait for daemon cleanup, or the next offer is declined as busy. */
async function waitForIdle(host: Host): Promise<void> {
  const until = Date.now() + IDLE_WAIT_MS;
  while (host.daemon.status().activeTaskCount > 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
}

/** Run one cell and write the redacted dataset and summary to `outDir`. */
export async function runCell(options: RunCellOptions): Promise<RunCellResult> {
  const log = options.log ?? (() => {});
  const caseIds = options.caseIds ?? CORPUS.map(entry => entry.id);
  let manifest: RunManifest = { ...plannedManifest({ ...options, caseIds }), startedAt: new Date().toISOString() };
  const trials: TrialRecord[] = [];
  const notStarted: NotStartedRow[] = [];
  const evidence = new Map<string, readonly ObservedEvent[]>();
  let calibration: CalibrationResult | null = null;
  let calibrationRecord: TrialRecord | NotStartedRow | null = null;
  let predicate: CallPredicate = UNCONFIRMED_PREDICATE;
  let completion: RunManifest['completion'] = 'complete';
  if (!manifest.corpus.preflight.ok) {
    completion = 'void';
  } else {
    const host = await openHost(options);
    try {
      manifest = { ...manifest, cell: { ...manifest.cell, observedRuntimes: (await host.server.machines.list()).flatMap(machine => machine.runtimes ?? []), activityMaxBytes: host.tap.activityMaxBytes } };
      const plan = planTrials({ rounds: options.rounds, caseIds, calibrate: options.calibrate });
      let startedCounted = 0;
      for (const planned of plan) {
        if (options.signal?.aborted) { completion = 'incomplete'; break; }
        if (planned.counted && startedCounted >= options.maxTrials) { completion = 'incomplete'; break; }
        log(`trial ${planned.trialId} (${planned.counted ? 'counted' : 'calibration'})`);
        const outcome = await runTrial(host, options, planned, predicate);
        if (outcome.kind === 'started') evidence.set(planned.trialId, outcome.events);
        if (!planned.counted) {
          const label = outcome.kind === 'started' ? calibrateLabel(outcome.events) : null;
          // The predicate is fixed here, before the first counted trial, and never changes after.
          predicate = label ? { confirmed: true, label, source: `calibration:${planned.trialId}` } : UNCONFIRMED_PREDICATE;
          calibration = { trialId: planned.trialId, caseId: planned.caseId, label, category: outcome.kind === 'started' ? outcome.record.category : 'not_started' };
          calibrationRecord = outcome.kind === 'started' ? outcome.record : outcome.row;
          continue;
        }
        if (outcome.kind === 'started') { trials.push(outcome.record); startedCounted++; } else {
          // A planned counted trial that did not start leaves the batch incomplete.
          notStarted.push(outcome.row);
          completion = 'incomplete';
        }
        // Stop the cell after an operator cancel or a halted daemon; later trials could not run.
        if (outcome.kind === 'started' && outcome.record.category === 'infrastructure_abort') { completion = 'incomplete'; break; }
      }
    } finally {
      await host.close();
    }
  }
  manifest = { ...manifest, predicate, calibration, endedAt: new Date().toISOString(), completion, startedTrials: trials.length, notStartedTrials: notStarted.length };
  const summary = summarizeRun({ runId: options.runId, cellId: options.cellId, caseIds, plannedPerCase: options.rounds, trials, notStarted });
  const realWorkRoot = await realpath(options.workRoot).catch(() => options.workRoot);
  const replacements = [[options.workRoot, '<run-root>'], [realWorkRoot, '<run-root>'], [path.resolve(options.outDir), '<out-dir>'], [os.homedir(), '<home>']] as const;
  const write = async (name: string, value: string) => {
    const file = path.join(options.outDir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
    return file;
  };
  const clean = <T>(value: T): T => redact(value, replacements);
  const header = [
    `Run ${options.runId}; mode ${manifest.mode}${manifest.synthetic ? ' (synthetic: plumbing only, not model behavior)' : ''}; completion ${completion}.`,
    `Runtime ${options.runtime}; corpus ${CORPUS_REVISION}; deadline ${options.deadlineMs} ms; predicate ${predicate.confirmed ? 'confirmed by calibration' : 'unconfirmed (no missing category)'}.`,
  ];
  const files = [
    await write('manifest.json', `${JSON.stringify(clean(manifest), null, 2)}\n`),
    await write('trials.jsonl', trials.map(trial => JSON.stringify(clean(trial))).join('\n') + (trials.length ? '\n' : '')),
    await write('not-started.jsonl', notStarted.map(row => JSON.stringify(clean(row))).join('\n') + (notStarted.length ? '\n' : '')),
    await write('calibration.json', `${JSON.stringify(clean(calibrationRecord), null, 2)}\n`),
    await write('summary.json', `${JSON.stringify(summary, null, 2)}\n`),
    await write('summary.md', clean(renderSummaryMarkdown(summary, header))),
  ];
  for (const [trialId, events] of evidence) files.push(await write(`events/${trialId}.json`, `${JSON.stringify(clean(events))}\n`));
  return { manifest: clean(manifest), trials: clean(trials), notStarted: clean(notStarted), files };
}

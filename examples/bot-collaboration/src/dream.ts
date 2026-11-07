import { buildDreamInstruction, buildHandoffPack, checkRoutineSchedule } from '@byok-sdk/protocol';
import { concludeOccurrence, hash, occurrenceIntentKey, occurrenceOfIntentKey, promoteOccurrence, routineCommands, setLifecycle, time,
  type ExecutionTemplate, type HostOccurrenceRoutineDefinition, type HostOccurrenceRun, type LedgerState, type Routine } from '@byok-sdk/server/execution-core';
import { json, stateOf, type CollaborationState, type Turn } from './model';
import { BOT_DREAM, dreamTable, ROUTINE_LATE_AFTER_MS, routineCalendar } from './routines';
import { handoffFrameBytes, handoffTurn, type ContextTurn } from './rules/context';
import { inactive } from './rules/team';

// Dreaming (#1475): each Bot gets a daily routine that tidies its memory. K8 owns the schedule and K4 owns the FIFO position,
// supersede and deadline of the dream intent. A dream is a fresh writer with `agentMemory: 'none'` and no `agentMemoryCommit`
// on every platform, so its cwd is the Bot's home and the device injects neither `MEMORY.md` nor memory guidance.

/** The time limit of a dream task. A user Turn behind a running dream waits at most this long. */
export const DEFAULT_DREAM_MAX_DURATION_MS = 900_000;
/** A dream can sit behind a night of Bot work, so it waits longer than a routine Turn. */
export const DREAM_WAIT_MS = 3_600_000;
const DREAM_HOUR = 3;
const MIN_PACK_BYTES = 1024;

/** `dreaming` of `BotOptions`. Absent means on with these defaults; `false` turns dreaming off for the whole Host. */
export interface DreamingOptions {
  /** IANA time zone of the daily 03:00 slot. Absent: this process's local zone when the routine is created, stored in its definition. */
  timeZone?: string;
  /**
   * Host model template names, preferred first. A dream takes the first that exists now and is on the Bot's device, else
   * the Bot's own template. Only this list decides what is cheap: K8 infers nothing from a runtime or vendor name.
   */
  models?: readonly string[];
  /** Default `DEFAULT_DREAM_MAX_DURATION_MS`. */
  maxDurationMs?: number;
  /** Request native session input when the device advertises it. Default true. */
  nativeSessions?: boolean;
}
export interface DreamPolicy { timeZone?: string; models: readonly string[]; maxDurationMs: number; nativeSessions: boolean }
const scheduleIn = (tz: string) => ({ minute: 0, hour: DREAM_HOUR, tz });
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Checks the option once, at construction. `undefined`: dreaming is off. */
export function dreamPolicy(options: DreamingOptions | false | undefined): DreamPolicy | undefined {
  if (options === false) return undefined;
  // The local zone is checked here too, because a routine created later could not fail any better than the constructor.
  const check = checkRoutineSchedule(scheduleIn(options?.timeZone ?? localZone()));
  if (!check.ok) throw new Error(`dreaming: ${check.code}: ${check.message}`);
  const maxDurationMs = time(options?.maxDurationMs ?? DEFAULT_DREAM_MAX_DURATION_MS);
  if (maxDurationMs < 1) throw new Error('dreaming: maxDurationMs must be positive');
  return { ...(options?.timeZone === undefined ? {} : { timeZone: options.timeZone }), models: [...options?.models ?? []], maxDurationMs, nativeSessions: options?.nativeSessions ?? true };
}

export type DreamSkip = 'superseded' | 'dreaming_off' | 'bot_archived' | 'bot_suspended' | 'device_unavailable' | 'bot_not_ready' | 'no_new_turns'
  | 'model_unavailable' | 'history_unavailable';
/** How one occurrence ended. `template` and `fallback` are set once a dream was offered. */
export interface DreamRecord {
  occurrenceKey: string; at: number; outcome: 'skipped' | 'succeeded' | 'failed' | 'declined' | 'cancelled' | 'expired' | 'superseded';
  reason?: string; template?: string; fallback?: boolean;
}
/** `since` starts the next window. `throughTurn` is the last Turn of the settled run of Turns that the last successful dream covered. */
export interface DreamBot { since: number; throughTurn?: string; last?: DreamRecord }
/** An occurrence that K8 has not closed. `template` is set when it joined the FIFO. */
export interface OpenDream { botId: string; windowEnd: number; template?: string; fallback?: boolean; throughTurn?: string }
/** The dream table. It owns each dream intent, as `hostIntents` owns a Host intent, and the Host intent API never reads it. */
export interface DreamState { bots: Record<string, DreamBot>; open: Record<string, OpenDream> }

const ownerOf = (routine: Routine): string | undefined => {
  const spec = routine.definition.hostOccurrence;
  return spec?.type === BOT_DREAM ? (spec.input as unknown as { owner: string }).owner : undefined;
};
/** The occurrence of a dream intent, or `undefined` for any other key. */
export function dreamOf(state: CollaborationState, intentKey: string): OpenDream | undefined {
  const key = occurrenceOfIntentKey(intentKey);
  return key !== undefined && state.dreams && Object.hasOwn(state.dreams.open, key) ? state.dreams.open[key] : undefined;
}
/** The intent ids of open dreams: background work that user input goes ahead of. */
export function dreamIntentIds(state: CollaborationState): string[] {
  return Object.keys(state.dreams?.open ?? {}).map(key => hash(occurrenceIntentKey(key)));
}
/** The `bot-dream` occurrence hook. A hook gets no K4 state, so the sync decides and promotes, as for a routine Turn. */
export function recordDream(state: CollaborationState, run: HostOccurrenceRun, now: number): void {
  dreamTable(state).open[run.occurrenceKey] = { botId: (run.input as { owner: string }).owner, windowEnd: now };
}

/** One dream routine for each unarchived Bot with a usable template, and no other. It runs in every sync, so it covers each way a Bot starts or ends. */
export function reconcileDreamRoutines(s: LedgerState, policy: DreamPolicy | undefined, models: Readonly<Record<string, ExecutionTemplate>>, now: number): void {
  const state = stateOf(s.application), rows = Object.values(s.routines).flatMap(row => { const owner = ownerOf(row); return owner === undefined ? [] : [{ row, owner }]; });
  const open = new Map<string, Routine>();
  for (const { row, owner } of rows) {
    if (row.lifecycle === 'completed') continue;
    const bot = state.team.bots[owner];
    if (policy && bot && !bot.archived && !open.has(owner)) open.set(owner, row);
    else setLifecycle(s, row.definition.id, 'completed', now, routineCalendar);
  }
  if (!policy) return;
  const commands = routineCommands(s, { now: () => now, nextTime: routineCalendar, hostJobs: new Map(), occurrenceHooks: new Map([[BOT_DREAM, recordDream]]), executionRoutines: 'refuse' });
  const definition = (id: string, version: number, owner: string, tz: string): HostOccurrenceRoutineDefinition => ({ id, version, timeZone: tz,
    rule: json(scheduleIn(tz)), waitMs: DREAM_WAIT_MS, lateAfterMs: ROUTINE_LATE_AFTER_MS, hostOccurrence: { type: BOT_DREAM, input: { owner } } });
  for (const bot of Object.values(state.team.bots)) {
    if (bot.archived) continue;
    const routine = open.get(bot.id), latest = routine?.pending ?? routine?.definition;
    if (latest) {
      // A routine keeps the local zone it was created with, so only an explicit zone moves it.
      if (policy.timeZone !== undefined && latest.timeZone !== policy.timeZone) commands.update(definition(latest.id, latest.version + 1, bot.id, policy.timeZone));
    } else if (models[bot.model]) {
      // A completed routine cannot resume, so turning dreaming back on takes a new id.
      commands.create(definition(`dream:${bot.id}:${rows.filter(row => row.owner === bot.id).length + 1}`, 1, bot.id, policy.timeZone ?? localZone()));
      dreamTable(state).bots[bot.id] ??= { since: now };
    }
  }
}

const completed = (row: Pick<Turn, 'status'>) => row.status === 'succeeded' || row.status === 'delivered';
/**
 * The rows after the mark, oldest first, up to the first that is still open. User input can overtake an older Turn, so a
 * dream never moves its mark past an open one, or that Turn would finish behind the mark and no dream would see it. A mark
 * that retention removed counts every remaining row as new.
 */
function settledAfter<T extends Pick<Turn, 'id' | 'status'>>(rows: readonly T[], mark: string | undefined): T[] {
  const after = rows.slice(rows.findIndex(row => row.id === mark) + 1);
  const open = after.findIndex(row => row.status === 'queued' || row.status === 'processing');
  return open < 0 ? after : after.slice(0, open);
}
function chooseModel(policy: DreamPolicy, models: Readonly<Record<string, ExecutionTemplate>>, botModel: string, deviceId: string) {
  const name = policy.models.find(model => Object.hasOwn(models, model) && models[model]!.deviceId === deviceId);
  if (name !== undefined) return { template: name, fallback: false, base: models[name]! };
  return models[botModel] ? { template: botModel, fallback: true, base: undefined } : undefined;
}
/** The template's runtime and limits with the Bot's Agent, and none of what a Bot Turn offers. */
function dreamExecution(base: ExecutionTemplate, bot: ExecutionTemplate, instruction: string, maxDurationMs: number, window: { fromMs: number; toMs: number }, nativeSessions: boolean): ExecutionTemplate {
  const { messageEgress: _egress, requiredToolsets: _toolsets, agentMemoryCommit: _commit, homeAccess: _home, preparation: _preparation, nativeSessions: _nativeSessions, ...payload } = base.payload;
  return { deviceId: bot.deviceId, payload: { ...payload, instruction, session: { mode: 'fresh' }, agentRef: bot.payload.agentRef, agentMemory: 'none',
    limits: { ...payload.limits, maxDurationMs }, terminalProjection: { mode: 'none' }, ...(nativeSessions ? { nativeSessions: { ...window, ifAdvertised: true } } : {}) } };
}
/** The pack fills what `instructionMaxBytes` leaves after the fixed text of the instruction. */
function dreamInstruction(rows: readonly (Turn | ContextTurn)[], window: { fromMs: number; toMs: number }, maxDurationMs: number, instructionMaxBytes: number): string {
  const budget = { maxDurationMs }, frame = { omittedTurns: 0, earlier: [], recent: [] };
  const fixed = Buffer.byteLength(buildDreamInstruction({ history: frame, window, budget }), 'utf8') - Buffer.byteLength(JSON.stringify(frame), 'utf8');
  const totalBytes = Math.max(instructionMaxBytes - fixed, handoffFrameBytes(rows.length));
  const history = buildHandoffPack(rows.map(handoffTurn), { recentBytes: Math.floor(totalBytes / 4 * 3), earlyBytes: totalBytes, totalBytes });
  return buildDreamInstruction({ history, window, budget });
}
/** Refuses an `instructionMaxBytes` that leaves a dream no room for history. */
export function checkDreamInstruction(instructionMaxBytes: number): void {
  const room = instructionMaxBytes - Buffer.byteLength(dreamInstruction([], { fromMs: 0, toMs: 0 }, 1, 0), 'utf8');
  if (room < MIN_PACK_BYTES) throw new Error(`instructionMaxBytes leaves a dream ${room} bytes of history, under ${MIN_PACK_BYTES}`);
}

export interface DreamSync {
  tenant: string; policy: DreamPolicy | undefined; models: Readonly<Record<string, ExecutionTemplate>>; instructionMaxBytes: number; now: number;
  /** The device of a Bot refuses new work. */
  refused(botId: string): boolean;
  /** Absent: the ledger's Turns are the history. Present: the rows an external history read returned by occurrence key, `null` for a failed read. */
  history?: ReadonlyMap<string, readonly ContextTurn[] | null> | undefined;
  historyMode: boolean;
}
/** Decides each new occurrence and closes each settled dream. Returns true when a dream joined the FIFO or an occurrence concluded. */
export function syncDreams(s: LedgerState, sync: DreamSync): boolean {
  const state = stateOf(s.application), dreams = state.dreams;
  if (!dreams) return false;
  let changed = false;
  const close = (key: string, run: OpenDream, outcome: DreamRecord['outcome'], reason?: string) => {
    const bot = dreams.bots[run.botId] ??= { since: run.windowEnd };
    bot.last = { occurrenceKey: key, at: run.windowEnd, outcome, ...(reason === undefined ? {} : { reason }),
      ...(run.template === undefined ? {} : { template: run.template, fallback: run.fallback! }) };
    if (outcome === 'succeeded') {
      bot.since = run.windowEnd;
      if (run.throughTurn !== undefined) bot.throughTurn = run.throughTurn;
    }
    delete dreams.open[key];
  };
  const skip = (key: string, run: OpenDream, reason: DreamSkip) => {
    const occurrence = s.occurrences[key];
    if (occurrence && !occurrence.conclusion) { concludeOccurrence(s, key, reason === 'superseded' ? 'superseded' : 'cancelled'); changed = true; }
    close(key, run, reason === 'superseded' ? 'superseded' : 'skipped', reason);
  };
  for (const [key, run] of Object.entries(dreams.open)) {
    const bot = state.team.bots[run.botId], stopped = !bot ? 'archived' : inactive(bot);
    if (run.template !== undefined) {
      const intent = s.intents[hash(occurrenceIntentKey(key))];
      if (!intent) close(key, run, 'failed', 'intent_compacted');
      else if (intent.conclusion) close(key, run, intent.conclusion);
      else if (stopped && intent.phase !== 'inflight' && !intent.cancelReason) intent.cancelReason = 'cancelled';
      continue;
    }
    if (s.occurrences[key]?.hook?.executionSuperseded) { skip(key, run, 'superseded'); continue; }
    if (!sync.policy) { skip(key, run, 'dreaming_off'); continue; }
    if (!bot || stopped) { skip(key, run, stopped === 'suspended' ? 'bot_suspended' : 'bot_archived'); continue; }
    if (sync.refused(bot.id)) { skip(key, run, 'device_unavailable'); continue; }
    if (bot.readyRevision !== bot.revision) { skip(key, run, 'bot_not_ready'); continue; }
    const record = dreams.bots[bot.id] ??= { since: run.windowEnd };
    const settled = settledAfter(Object.values(state.turns).filter(turn => turn.botId === bot.id), record.throughTurn), fresh = settled.filter(completed);
    if (!fresh.length) { skip(key, run, 'no_new_turns'); continue; }
    const model = chooseModel(sync.policy, sync.models, bot.model, bot.execution.deviceId);
    if (!model) { skip(key, run, 'model_unavailable'); continue; }
    let rows: readonly (Turn | ContextTurn)[] = fresh;
    if (sync.historyMode) {
      const read = sync.history?.get(key);
      if (read === undefined) continue;
      if (read === null) { skip(key, run, 'history_unavailable'); continue; }
      rows = settledAfter(read, record.throughTurn).filter(completed);
    }
    const window = { fromMs: Math.min(record.since, run.windowEnd), toMs: run.windowEnd };
    const instruction = dreamInstruction(rows, window, sync.policy.maxDurationMs, sync.instructionMaxBytes);
    Object.assign(run, { template: model.template, fallback: model.fallback, throughTurn: settled.at(-1)!.id });
    promoteOccurrence(s, sync.tenant, key, dreamExecution(model.base ?? bot.execution, bot.execution, instruction, sync.policy.maxDurationMs, window, sync.policy.nativeSessions));
    changed = true;
  }
  return changed;
}
/** The dreams that wait for an external history read, by occurrence key, with the Bot and the intent key of the read. */
export function dreamReads(state: CollaborationState): { key: string; botId: string; turnId: string }[] {
  return Object.entries(state.dreams?.open ?? {}).filter(([, run]) => run.template === undefined)
    .map(([key, run]) => ({ key, botId: run.botId, turnId: occurrenceIntentKey(key) }));
}

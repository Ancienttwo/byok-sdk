import type { BotTurnOutcome } from '@byok-sdk/protocol';
import { hash } from '@byok-sdk/server/execution-core/canonical';
import { addTurn, json, type Json, type Rejection, type ReplyEntry, type Turn, type TurnsState, type Verdict } from './turn';
import { frame, REPLY_META_MAX_BYTES } from './frame';

/**
 * Cross-Bot delegation as pure rules (#739 D1): budget units, the batch join, verdicts, cancel arbitration and
 * the Cross-Bot Request. Each function changes only the slice that the caller gives, does no I/O and takes `now`
 * from the caller. The Host gives the K4 intent facts of each Turn, stores the slice and sends each emitted row.
 */
/**
 * Frozen in the arbitration transaction (§8.8). `delivered` turns true after core.cancel. No `reason` means a user cancel.
 * `target_archived` is the Host cancel when the target Bot is archived (§8.4). Its verdict is `refused`.
 */
export interface DelegationCancel { requestedAt: number; targetTurnId: string; delivered: boolean; reason?: 'main_bot_cancelled' | 'target_archived' }
export interface Delegation {
  id: string; root: string; fromBotId: string; fromTurnId: string; fromTaskId: string; index: number;
  toBotId: string; toAgentRef?: { agentId: string; profileRevision: string }; toDeviceId?: string;
  request: string; hop: number; requestTurnId?: string; chainTurnIds: string[]; batch: string;
  status: 'queued' | 'waiting_device' | 'running' | 'reply_pending' | 'reply_held' | 'uncertain' | 'resolved';
  revision: number; nextCheckAt?: number; checks?: number; pendingSince?: number;
  verdict?: Verdict; reason?: string; reply?: string; continuationRefused?: true; partial?: true; replyTurnId?: string;
  uncertainSince?: number; resolvedAt?: number;
  cancel?: DelegationCancel;
  /** First observed claim of the current chain Turn (§8.3). */
  claimed?: { turnId: string; at: number };
  /** A chain Turn still open at the verdict. Its later terminal goes to audit only. */
  lateTurnId?: string;
  /** The verdict has no reply Turn because the initiator is archived (§8.5). */
  undelivered?: 'initiator_archived';
}
/**
 * One A outcome. `slots` are the prepaid A reply units of this batch.
 * `released` is set at the first report, or when every accepted delegation is uncertain (§3.5).
 */
export interface Batch { id: string; delegationIds: string[]; slots: string[]; released?: true }
/** `turnId` is the Turn that holds the unit. A free A slot has none. */
export interface Unit { id: string; root: string; state: 'reserved' | 'spent' | 'released'; turnId?: string }
export interface AcceptedReply {
  turnId: string; messageId: string; contentHash: string; contentType: string; acceptedAt: number;
  /** Stored only for delegation chain Turns. */
  body?: string;
}
/** The Bot fields that delegation reads. */
export interface DelegationBot {
  readonly id: string; readonly name: string; readonly archived: boolean;
  readonly execution: { readonly deviceId: string; readonly payload: { readonly agentRef: { readonly agentId: string; readonly profileRevision: string } } };
}
/** The collaboration rows that delegation reads and changes. */
export interface DelegationState extends TurnsState {
  team: { bots: Readonly<Record<string, DelegationBot>> };
  delegations: Record<string, Delegation>; batches: Record<string, Batch>; units: Record<string, Unit>;
  replies: Record<string, AcceptedReply>; rejected: Rejection[]; audit: string[];
}
/** The rows that the Cross-Bot Request and the ContextPack delegation views read. */
export interface DelegationView {
  team: { bots: Readonly<Record<string, { readonly name: string }>> };
  delegations: Record<string, Delegation>; replies: Record<string, AcceptedReply>;
}
/** The same values as the K4 intent `Conclusion`. Rules do not import K4 types. */
export type Conclusion = 'succeeded' | 'failed' | 'declined' | 'cancelled' | 'expired' | 'superseded';
/** The current K4 intent of one Turn. */
export interface IntentFact { taskId: string; conclusion?: Conclusion; cancelReason?: 'expired' | 'cancelled' }
/** K4 facts by Turn id. A Turn with no K4 intent has no facts. */
export interface IntentFacts {
  intent(turnId: string): IntentFact | undefined;
  /** An execution of any generation started, or has a terminal that is not a decline. */
  started(turnId: string): boolean;
  /** The decline code of the current execution's terminal, if it is a decline. */
  declineCode(turnId: string): string | undefined;
  /** The device of a delivered offer of an inflight intent that no device has claimed yet. */
  offeredTo(turnId: string): string | undefined;
}

/** Host cap on a delegated Bot's accepted reply (Q8). consumeMessage checks it too. */
export const BOT_REPLY_MAX_BYTES = 8192;
/** Header, end line and line breaks of one framed block. */
export const FRAME_MAX_BYTES = 96;
export const ROOT_BOT_BUDGET = 12;
export const HOP_LIMIT = 4;
export const DEFAULT_INSTRUCTION_MAX_BYTES = 65_536;
/** Roster entry: 64-byte id, name <= 40 and role <= 80 code points at 6 bytes each, keys. */
export const ROSTER_ENTRY_MAX_BYTES = 848;
/** historyWindow with its notice, and the keys of truncated arrays. */
export const CONTEXT_FIXED_MAX_BYTES = 1024;
export const REPLY_REQUEST_MAX_BYTES = 2 * (BOT_REPLY_MAX_BYTES + REPLY_META_MAX_BYTES + FRAME_MAX_BYTES);
export const BOT_REQUEST_MAX_BYTES = 4000 + REPLY_META_MAX_BYTES + FRAME_MAX_BYTES;
export const REPLY_RETRY_MAX_MS = 60_000;
export const REPLY_UNCERTAIN_AFTER_MS = 30 * 60_000;
/** §8.3 (Q9): a cancel with no terminal, and a claimed attempt with no terminal, show `uncertain`. */
export const DEFAULT_CANCEL_GRACE_MS = 60_000;
export interface DelegationTimers { cancelGraceMs: number; uncertainAfterMs: number }
const DEFAULT_TIMERS: DelegationTimers = { cancelGraceMs: DEFAULT_CANCEL_GRACE_MS, uncertainAfterMs: REPLY_UNCERTAIN_AFTER_MS };
const TEAM_BOT_LIMIT = 24;
/** §8.8: the Main Bot cancel enum lists at most this many open delegations, newest first. */
export const OPEN_DELEGATIONS_MAX_ITEMS = 24;
const OPEN_REQUEST_MAX_CODE_POINTS = 80;
/** Listed entry: three 64-byte ids, status, request <= 80 code points at 6 bytes each, keys. */
export const OPEN_DELEGATION_ENTRY_MAX_BYTES = 768;
/** The listed entries, the omitted count and its notice, and the keys. */
export const OPEN_DELEGATIONS_MAX_BYTES = OPEN_DELEGATIONS_MAX_ITEMS * OPEN_DELEGATION_ENTRY_MAX_BYTES + 256;

export function isCrossBot(turn: Turn): boolean { return turn.source === 'bot_request' || turn.source === 'bot_reply'; }
/** UTF-8 bytes of the instruction parts around the Request and ContextPack sections. */
export function instructionOverhead(prompt: string): number {
  return Buffer.byteLength(`${prompt}\n\nRequest:\n\n\nContextPack:\n`, 'utf8');
}
/** Construction check (§3.7): P + max(R_reply, R_req) + F_max. A Main Bot reply Turn also lists open delegations (§8.8). */
export function minimumInstructionBytes(prompt: string): number {
  return instructionOverhead(prompt) + Math.max(REPLY_REQUEST_MAX_BYTES, BOT_REQUEST_MAX_BYTES)
    + TEAM_BOT_LIMIT * ROSTER_ENTRY_MAX_BYTES + CONTEXT_FIXED_MAX_BYTES + OPEN_DELEGATIONS_MAX_BYTES;
}

export type Publish = (id: string, value: Json) => void;
const cut = (text: string, codePoints: number) => [...text].slice(0, codePoints).join('');

// Unit ledger (§6.2). Each unit moves once: reserved -> spent, or reserved -> released.
function budget(state: DelegationState, root: string) {
  return state.budgets[root] ??= { continuation: 0, delegation: 0 };
}
function freeUnits(state: DelegationState, root: string): number {
  const row = budget(state, root);
  return ROOT_BOT_BUDGET - row.delegation - (row.reserved ?? 0);
}
function reserve(state: DelegationState, root: string, id: string): void {
  if (state.units[id]) return;
  const row = budget(state, root);
  if (freeUnits(state, root) < 1) throw new Error('Root Bot budget invariant: spent + reserved <= 12');
  row.reserved = (row.reserved ?? 0) + 1;
  state.units[id] = { id, root, state: 'reserved' };
}
export function claimUnit(state: DelegationState, id: string | undefined): void {
  const unit = id === undefined ? undefined : state.units[id];
  if (unit?.state !== 'reserved') return;
  const row = budget(state, unit.root);
  unit.state = 'spent'; row.reserved! -= 1; row.delegation += 1;
}
export function releaseUnit(state: DelegationState, id: string | undefined): void {
  const unit = id === undefined ? undefined : state.units[id];
  if (unit?.state !== 'reserved') return;
  unit.state = 'released'; budget(state, unit.root).reserved! -= 1;
}

function publish(d: Delegation, emit: Publish): void {
  d.revision++;
  emit(`delegation:${d.id}:${d.revision}`, json({ id: d.id, revision: d.revision, fromBotId: d.fromBotId, toBotId: d.toBotId,
    request: d.request, status: d.status, verdict: d.verdict, reason: d.reason, replyTurnId: d.replyTurnId, undelivered: d.undelivered }));
}
function close(d: Delegation, verdict: Verdict, now: number, reason?: string, reply?: string): void {
  d.verdict = verdict; d.status = 'resolved'; d.resolvedAt = now;
  if (reason) d.reason = reason;
  if (reply) d.reply = reply;
  delete d.nextCheckAt;
}
function entry(d: Delegation): ReplyEntry {
  return { delegationId: d.id, from: d.toBotId, request: d.request, verdict: d.verdict!,
    ...(d.reason ? { reason: d.reason } : {}), ...(d.reply ? { reply: d.reply } : {}),
    ...(d.continuationRefused ? { continuationRefused: true as const } : {}), ...(d.partial ? { partial: true as const } : {}) };
}
/** Delivery (§8.2): one reply Turn per report. It runs only when a prepaid A slot is free. */
function report(state: DelegationState, batch: Batch, rows: Delegation[], id: string, refusalReport: boolean): void {
  const origin = state.turns[rows[0]!.fromTurnId]!;
  const initiator = state.team.bots[origin.botId];
  if (!initiator || initiator.archived) {
    // §8.5: the verdict stays in the ledger, with no reply Turn. The projection shows why.
    for (const slot of batch.slots) if (!state.units[slot]!.turnId) releaseUnit(state, slot);
    for (const row of rows) row.undelivered = 'initiator_archived';
    return;
  }
  const slot = batch.slots.find(unit => state.units[unit]!.state === 'reserved' && !state.units[unit]!.turnId);
  const replies = rows.map(entry);
  const turn = addTurn(state, { id, root: origin.root, source: 'bot_reply', botId: origin.botId, hop: origin.hop,
    authority: origin.authority ?? 'bot', replies, ...(refusalReport ? { refusalReport } : {}), ...(slot ? { unit: slot } : {}),
    request: `Delegation replies: ${replies.map(r => `${r.from} ${r.verdict}${r.reason ? ` (${r.reason})` : ''}`).join('; ')}` });
  if (slot) state.units[slot]!.turnId = id;
  else { turn.status = 'delivered'; turn.conclusion = 'delivered'; }
  for (const row of rows) row.replyTurnId = id;
  // The batch keeps one free slot for each accepted delegation that is not reported yet (§6.2).
  const open = batch.delegationIds.filter(key => state.delegations[key]!.requestTurnId && !state.delegations[key]!.replyTurnId).length;
  batch.slots.filter(unit => state.units[unit]!.state === 'reserved' && !state.units[unit]!.turnId).slice(open)
    .forEach(unit => releaseUnit(state, unit));
}
/**
 * Fan-in join (§3.5). The first report waits until every accepted delegation of
 * the batch has a verdict or is uncertain. It carries every verdict so far,
 * apply-time refusals included. With every accepted delegation uncertain there
 * is no batch Turn. After the release, each verdict reports in its own Turn.
 * `d` is the delegation that just got its verdict. Returns the reported rows.
 */
function deliver(state: DelegationState, batch: Batch, d?: Delegation): Delegation[] {
  const rows = batch.delegationIds.map(id => state.delegations[id]!);
  const accepted = rows.filter(row => row.requestTurnId);
  const unreported = rows.filter(row => row.verdict && !row.replyTurnId && !row.undelivered);
  if (!batch.released) {
    if (accepted.some(row => !row.verdict && row.status !== 'uncertain')) return [];
    batch.released = true;
    if (accepted.length && !accepted.some(row => row.verdict)) return [];
    // A batch of one keeps the single key `H('bot_reply', delegationId)`.
    report(state, batch, unreported, hash(['bot_reply', accepted.length === 1 ? accepted[0]!.id : batch.id]), !accepted.length);
    return unreported;
  }
  if (!d || d.replyTurnId) return [];
  const late = [d, ...unreported.filter(row => row !== d && !row.requestTurnId)];
  report(state, batch, late, hash(['bot_reply', d.id]), false);
  return late;
}
/** Set the verdict once, then deliver it through the batch join. */
export function resolveDelegation(state: DelegationState, d: Delegation, verdict: Verdict, now: number, emit: Publish,
  reason?: string, reply?: string): boolean {
  if (d.verdict) return false;
  close(d, verdict, now, reason, reply);
  // A B unit whose Turn never started is no longer needed.
  releaseUnit(state, hash([d.id, 'B']));
  for (const row of new Set([d, ...deliver(state, state.batches[d.batch]!, d)])) publish(row, emit);
  return true;
}

/** Units that a batch with `n` accepted cross-Bot items prepays: n B units and max(n, 1) A reply slots (Q10). */
export function reserveUnits(n: number): number { return n + Math.max(n, 1); }
/**
 * Apply every delegate item of one outcome (§3.1). Self items keep the K8a
 * continuation path. The accepted cross-Bot items form one batch (§3.5).
 */
export function applyDelegate(state: DelegationState, turn: Turn, taskId: string, outcome: BotTurnOutcome, seat: boolean,
  now: number, emit: Publish, accept: (action: string, work: () => void) => void): { successor: boolean } {
  let successor = false;
  let self = false;
  const targets = new Set<string>();
  const rows: Delegation[] = [];
  const accepted: Delegation[] = [];
  outcome.delegate?.forEach((action, index) => {
    const id = hash([taskId, 'delegate', index]);
    if (action.to === turn.botId) {
      accept('delegate', () => {
        if (self) throw new Error('Duplicate delegation target');
        self = true;
        if (state.turns[id]) { successor = true; return; }
        const limits = budget(state, turn.root);
        if (limits.continuation >= 4) throw new Error('Continuation budget is 4');
        limits.continuation++;
        // A continuation keeps hop, authority and the open delegation of its parent.
        addTurn(state, { id, root: turn.root, source: 'continuation', request: action.request, botId: turn.botId, hop: turn.hop,
          authority: turn.authority ?? 'bot', ...(turn.delegationId ? { delegationId: turn.delegationId } : {}) });
        if (turn.delegationId) state.delegations[turn.delegationId]!.chainTurnIds.push(id);
        successor = true;
      });
      return;
    }
    if (state.delegations[id]) return;
    const target = state.team.bots[action.to];
    const row: Delegation = { id, root: turn.root, fromBotId: turn.botId, fromTurnId: turn.id, fromTaskId: taskId, index,
      toBotId: action.to, request: action.request, hop: turn.hop + 1, chainTurnIds: [], batch: taskId, status: 'queued', revision: 0 };
    const reason = seat ? 'room_seat' : targets.has(action.to) ? 'duplicate_target' : !target || target.archived ? 'target_archived'
      : row.hop > HOP_LIMIT ? 'hop_limit' : undefined;
    targets.add(action.to);
    state.delegations[id] = row;
    rows.push(row);
    if (reason) close(row, 'refused', now, reason);
    else accepted.push(row);
  });
  if (!rows.length) return { successor };
  // Root admission over every open reservation: spent + reserved + reserve(n) <= 12. Refuse from the last index.
  budget(state, turn.root).reserved ??= 0;
  while (accepted.length && freeUnits(state, turn.root) < reserveUnits(accepted.length)) close(accepted.pop()!, 'refused', now, 'budget_exhausted');
  const batch: Batch = state.batches[taskId] = { id: taskId, delegationIds: rows.map(row => row.id), slots: [] };
  // With no accepted item, the refusal report takes a slot only when one is free (§8.2).
  const slots = accepted.length || Math.min(1, freeUnits(state, turn.root));
  for (let k = 0; k < slots; k++) {
    const slot = hash([taskId, 'A', k]);
    reserve(state, turn.root, slot);
    batch.slots.push(slot);
  }
  for (const row of rows) if (row.verdict) state.rejected.push({ botId: turn.botId, taskId, action: 'delegate', reason: row.reason! });
  for (const row of accepted) {
    const target = state.team.bots[row.toBotId]!, unit = hash([row.id, 'B']);
    reserve(state, turn.root, unit);
    Object.assign(row, { toAgentRef: { ...target.execution.payload.agentRef },
      toDeviceId: target.execution.deviceId, requestTurnId: row.id, chainTurnIds: [row.id] });
    addTurn(state, { id: row.id, root: turn.root, source: 'bot_request', request: row.request, botId: target.id,
      hop: row.hop, authority: 'bot', delegationId: row.id, unit });
    state.units[unit]!.turnId = row.id;
  }
  deliver(state, batch);
  for (const row of rows) publish(row, emit);
  return { successor };
}

/** Claim (first observed start spends the unit), the claim time of a chain Turn, and queued -> running. */
export function observeStart(state: DelegationState, turn: Turn, now: number, emit: Publish): void {
  claimUnit(state, turn.unit);
  const d = turn.delegationId ? state.delegations[turn.delegationId] : undefined;
  if (!d || d.verdict) return;
  const fresh = d.claimed?.turnId !== turn.id;
  if (fresh) d.claimed = { turnId: turn.id, at: now };
  // A successor that starts after an uncertain claim runs again (§8.3: a later terminal gives the normal verdict).
  if (d.status === 'queued' || d.status === 'waiting_device' || fresh && d.status === 'uncertain' && !d.cancel) { d.status = 'running'; publish(d, emit); }
}
/** Presence is display evidence only. It never controls submit, expiry, or a verdict. */
export function observeDevices(state: DelegationState, facts: IntentFacts, devices: ReadonlyMap<string, boolean>, emit: Publish): void {
  for (const d of Object.values(state.delegations)) {
    if (d.verdict || d.cancel || d.status !== 'queued' && d.status !== 'waiting_device') continue;
    const key = d.chainTurnIds.at(-1) ?? '', intent = facts.intent(key);
    // Persona waits and FIFO waits remain queued. Only a delivered, unclaimed offer waits for a device.
    const device = intent && !intent.conclusion ? facts.offeredTo(key) : undefined;
    if (device === undefined) continue;
    const connected = devices.get(device);
    if (connected === undefined) continue;
    const status = connected ? 'queued' : 'waiting_device';
    if (d.status !== status) { d.status = status; publish(d, emit); }
  }
}
/** Display only (§8.3). An uncertain delegation no longer holds back its batch. */
function uncertain(state: DelegationState, d: Delegation, now: number, emit: Publish): void {
  d.status = 'uncertain'; d.uncertainSince = now; publish(d, emit);
  for (const row of deliver(state, state.batches[d.batch]!)) publish(row, emit);
}
/**
 * Cancel verdict. A reply accepted before the cancel rides along as partial (§8.8).
 * An archived target gives `refused`, and its accepted reply is audit only (§8.4).
 */
function resolveCancel(state: DelegationState, d: Delegation, taskId: string | undefined, now: number, emit: Publish): void {
  const reply = taskId !== undefined && state.replies[taskId]?.body !== undefined ? taskId : undefined;
  if (d.cancel!.reason === 'target_archived') {
    if (reply) state.audit.push(`Delegation reply after archive: ${d.id} ${reply}`);
    resolveDelegation(state, d, 'refused', now, emit, 'target_archived');
    return;
  }
  if (reply) d.partial = true;
  resolveDelegation(state, d, 'cancelled', now, emit, d.cancel!.reason ?? 'user_cancelled', reply);
}
const CANCELLABLE = new Set<Delegation['status']>(['queued', 'waiting_device', 'running', 'reply_pending']);
/**
 * Open delegations that a Main Bot can cancel (§8.8): no verdict, no cancel yet,
 * and a state that a cancel can act on. Newest first; the rest are only counted.
 */
export function openDelegations(state: Pick<DelegationView, 'delegations'>): { items: Delegation[]; omitted: number } {
  const open = Object.values(state.delegations).filter(d => !d.verdict && !d.cancel && CANCELLABLE.has(d.status)).reverse();
  return { items: open.slice(0, OPEN_DELEGATIONS_MAX_ITEMS), omitted: Math.max(0, open.length - OPEN_DELEGATIONS_MAX_ITEMS) };
}
/** ContextPack view of the cancel enum. The enum is never cut without this notice. */
export function openDelegationsContext(state: Pick<DelegationView, 'delegations'>) {
  const { items, omitted } = openDelegations(state);
  return { items: items.map(d => ({ id: d.id, from: d.fromBotId, to: d.toBotId, status: d.status, request: cut(d.request, OPEN_REQUEST_MAX_CODE_POINTS) })),
    omitted, notice: omitted ? `${omitted} more open delegations are not listed. The owner can cancel them.` : null };
}
/**
 * Arbitration transaction (§8.8). Freeze the cancel fact on the current chain
 * Turn. That closes its first acceptance and blocks new successors. Without a
 * K4 intent, close queue eligibility and set the verdict now. Returns true when
 * core.cancel must still deliver the cancel. An archived target is cancelled in
 * every open state (§8.4).
 */
export function arbitrateCancel(state: DelegationState, facts: Pick<IntentFacts, 'intent'>, d: Delegation, now: number, emit: Publish,
  reason?: DelegationCancel['reason']): boolean {
  if (d.verdict) throw new Error('Delegation already resolved');
  if (d.cancel) return !d.cancel.delivered;
  if (reason !== 'target_archived' && !CANCELLABLE.has(d.status)) throw new Error('Delegation cannot be cancelled in this state; use abandonDelegation');
  const target = state.turns[d.chainTurnIds.at(-1)!]!, intent = facts.intent(target.id);
  d.cancel = { requestedAt: now, targetTurnId: target.id, delivered: !intent || !!intent.conclusion, ...(reason ? { reason } : {}) };
  if (!intent) {
    target.status = 'failed'; target.conclusion = 'cancelled'; delete target.blockedReason;
    emit(`bot-turn:${target.id}`, json({ owner: target.botId, ...target }));
    target.reported = true;
    resolveCancel(state, d, undefined, now, emit);
  } else if (intent.conclusion) resolveCancel(state, d, intent.taskId, now, emit);
  return !d.cancel.delivered;
}

/** B chain end after a success terminal: the Host acceptance record is the body authority (§3.3). */
export function endChain(state: DelegationState, turn: Turn, taskId: string, proposedSelf: boolean, now: number, emit: Publish): void {
  const d = state.delegations[turn.delegationId!]!;
  if (proposedSelf) d.continuationRefused = true;
  if (state.replies[taskId]?.body !== undefined) { resolveDelegation(state, d, 'answered', now, emit, undefined, taskId); return; }
  Object.assign(d, { status: 'reply_pending', pendingSince: now, nextCheckAt: now, checks: 0 });
  publish(d, emit);
}

const BUSY = new Set(['agent_home_writer_busy', 'agent_home_reader_busy']);
/** §8.1: K4 conclusion of a chain end that did not succeed -> verdict. */
function failure(facts: IntentFacts, key: string, intent: IntentFact | undefined, conclusion: Conclusion): { verdict: Verdict; reason?: string } {
  if (conclusion === 'cancelled') {
    // A Host cancel with reason expired: the claim raced the wait deadline (WO-05 ruling).
    return intent?.cancelReason === 'expired' ? { verdict: 'expired', reason: 'claim_raced_deadline' } : { verdict: 'cancelled', reason: 'user_cancelled' };
  }
  if (conclusion === 'expired') return { verdict: 'expired' };
  if (conclusion === 'declined') {
    const code = intent && facts.declineCode(key);
    return { verdict: 'failed', reason: !code || BUSY.has(code) ? 'busy' : code };
  }
  return { verdict: 'failed' };
}
/**
 * Units, claims, cancels, uncertain states, and verdicts of chain ends that did not succeed. Runs inside sync.
 * A later generation reuses the spent unit; a decline terminal is not a run.
 */
export function settleDelegations(state: DelegationState, facts: IntentFacts, now: number, emit: Publish, timers: DelegationTimers = DEFAULT_TIMERS): void {
  for (const turn of Object.values(state.turns)) {
    if (!turn.unit || state.units[turn.unit]?.state !== 'reserved') continue;
    if (facts.started(turn.id)) observeStart(state, turn, now, emit);
    else if (facts.intent(turn.id)?.conclusion || turn.conclusion && !facts.intent(turn.id)) releaseUnit(state, turn.unit);
  }
  for (const d of Object.values(state.delegations)) {
    if (d.lateTurnId && facts.intent(d.lateTurnId)?.conclusion) {
      // A terminal after the verdict is audit only. It never reaches the initiator (§4.3).
      state.audit.push(`Delegation terminal after verdict: ${d.id} ${facts.intent(d.lateTurnId)!.taskId}`);
      delete d.lateTurnId;
    }
    if (d.verdict || !d.chainTurnIds.length) continue;
    const last = state.turns[d.chainTurnIds.at(-1)!]!, intent = facts.intent(last.id);
    if (facts.started(last.id)) observeStart(state, last, now, emit);
    // §8.4: archiving the target is a Host cancel of its current chain Turn. deliverCancels sends it.
    if (!d.cancel && state.team.bots[d.toBotId]?.archived) arbitrateCancel(state, facts, d, now, emit, 'target_archived');
    if (d.verdict) continue;
    if (d.cancel) {
      const target = state.turns[d.cancel.targetTurnId]!, cancelled = facts.intent(target.id);
      if (cancelled?.conclusion || !cancelled && target.conclusion) resolveCancel(state, d, cancelled?.taskId, now, emit);
      else if (d.status !== 'uncertain' && now - d.cancel.requestedAt >= timers.cancelGraceMs) uncertain(state, d, now, emit);
      continue;
    }
    if (d.nextCheckAt !== undefined) {
      if (intent && state.replies[intent.taskId]?.body !== undefined) resolveDelegation(state, d, 'answered', now, emit, undefined, intent.taskId);
      continue;
    }
    const conclusion = intent?.conclusion ?? (last.conclusion as Conclusion | undefined);
    if (!conclusion) {
      // Display only: no resubmit and no new generation (§8.3).
      if (d.status !== 'uncertain' && d.claimed?.turnId === last.id && now - d.claimed.at >= timers.uncertainAfterMs) uncertain(state, d, now, emit);
      continue;
    }
    if (conclusion === 'succeeded') continue;
    const mapped = failure(facts, last.id, intent, conclusion);
    resolveDelegation(state, d, mapped.verdict, now, emit, mapped.reason);
  }
}
/** "End" (§8.3). An attempt that can still run gets a K4 cancel. Its later terminal goes to audit only. */
export function abandonDelegation(state: DelegationState, facts: Pick<IntentFacts, 'intent'>, d: Delegation, now: number, emit: Publish): boolean {
  if (d.status !== 'reply_held' && d.status !== 'uncertain') throw new Error('Delegation cannot be ended in this state');
  const last = d.chainTurnIds.at(-1)!, intent = facts.intent(last);
  if (intent && !intent.conclusion) {
    d.cancel ??= { requestedAt: now, targetTurnId: last, delivered: false };
    d.lateTurnId = last;
  }
  resolveDelegation(state, d, 'abandoned', now, emit, d.status === 'reply_held' ? 'reply_held' : undefined);
  return !!d.cancel && !d.cancel.delivered;
}
/** Next time a delegation timer can change state without other events. */
export function delegationDue(state: Pick<DelegationState, 'delegations'>, timers: DelegationTimers = DEFAULT_TIMERS): number[] {
  return Object.values(state.delegations).flatMap(d => [
    ...(d.nextCheckAt !== undefined ? [d.nextCheckAt] : []),
    ...(!d.verdict && d.status !== 'uncertain' && d.cancel ? [d.cancel.requestedAt + timers.cancelGraceMs] : []),
    ...(!d.verdict && d.status === 'running' && !d.cancel && d.claimed && d.claimed.turnId === d.chainTurnIds.at(-1) ? [d.claimed.at + timers.uncertainAfterMs] : []),
  ]);
}

/** SDK readback for a reply_pending delegation without a Host record (§3.3). */
export function reconcileReply(state: DelegationState, d: Delegation, readback: { disposition?: { outcome: string } } | undefined,
  now: number, emit: Publish, uncertainAfterMs = REPLY_UNCERTAIN_AFTER_MS): void {
  if (d.verdict || d.nextCheckAt === undefined) return;
  if (!readback || readback.disposition?.outcome === 'refused') { resolveDelegation(state, d, 'failed', now, emit, 'no_reply'); return; }
  if (readback.disposition?.outcome === 'held') {
    d.status = 'reply_held'; delete d.nextCheckAt; publish(d, emit); return;
  }
  // Pending, or accepted without a Host record: the Host alone authors the reply body.
  retryReply(state, d, now, emit, uncertainAfterMs);
}
export function retryReply(state: DelegationState, d: Delegation, now: number, emit: Publish, uncertainAfterMs = REPLY_UNCERTAIN_AFTER_MS): void {
  d.checks = (d.checks ?? 0) + 1;
  d.nextCheckAt = now + Math.min(REPLY_RETRY_MAX_MS, 1000 * 2 ** (d.checks - 1));
  if (d.status !== 'uncertain' && now - (d.pendingSince ?? now) >= uncertainAfterMs) uncertain(state, d, now, emit);
}

/** The SDK reply readback that `reconcileReply` reads (`tasks.agentMessage`). */
export type ReplyReadback = { disposition?: { outcome: string } } | undefined;
/**
 * One reply check of a delegation's chain end (§3.10). `taskId` is the chain end's task when it has an intent. The check
 * `failed` when the chain end has no intent, or when the SDK read threw.
 */
export type ReplyCheck = { taskId?: string; failed: true } | { taskId: string; failed: false; readback: ReplyReadback };
/** A delegation whose reply check is due at `now`: it has no verdict, and its check time has come. */
export function replyCheckDue(d: Delegation, now: number): boolean {
  return !d.verdict && d.nextCheckAt !== undefined && d.nextCheckAt <= now;
}
/**
 * The decision of one reply check (§3.10). A reply body that the Host holds answers the delegation; a failed read retries;
 * otherwise the readback decides.
 */
export function checkReply(state: DelegationState, d: Delegation, check: ReplyCheck, now: number, emit: Publish,
  uncertainAfterMs = REPLY_UNCERTAIN_AFTER_MS): void {
  if (check.taskId !== undefined && state.replies[check.taskId]?.body !== undefined) resolveDelegation(state, d, 'answered', now, emit, undefined, check.taskId);
  else if (check.failed) retryReply(state, d, now, emit, uncertainAfterMs);
  else reconcileReply(state, d, check.readback, now, emit, uncertainAfterMs);
}

function sender(state: Pick<DelegationView, 'team'>, botId: string) {
  return { botId, name: cut(state.team.bots[botId]?.name ?? '', 40) };
}
/** B's delegation block. It is metadata only: the request text stays in the Request section. */
export function delegationBlock(state: Pick<DelegationView, 'team' | 'delegations'>, turn: Turn) {
  const d = state.delegations[turn.delegationId!]!;
  return { delegationId: d.id, from: sender(state, d.fromBotId), hop: d.hop };
}
/**
 * Request section of a Cross-Bot Turn (§3.7). Request text and reply bodies
 * appear once as raw UTF-8 in length-framed blocks, with no second JSON encoding.
 */
export function crossBotRequest(state: DelegationView, turn: Turn): string {
  if (turn.source === 'bot_request') return frame('request', delegationBlock(state, turn), turn.request);
  return (turn.replies ?? []).map((reply, index) => frame(`reply ${index + 1}`, {
    delegationId: reply.delegationId, from: sender(state, reply.from), request: cut(reply.request, 200), verdict: reply.verdict,
    ...(reply.reason ? { reason: reply.reason } : {}), ...(reply.continuationRefused ? { continuationRefused: true } : {}),
    ...(reply.partial ? { partial: true } : {}),
  }, reply.reply ? state.replies[reply.reply]?.body ?? '' : '')).join('\n');
}

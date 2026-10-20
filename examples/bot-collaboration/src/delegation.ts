import type { BotTurnOutcome } from '@byok-sdk/protocol';
import { canonical, hash, taskId as taskIdOf, type Conclusion, type Intent, type Json, type LedgerState } from '@byok-sdk/example-host-execution-core';
import { addTurn, json, type Batch, type CollaborationState, type Delegation, type DelegationCancel, type ReplyEntry, type Turn, type Verdict } from './model';

/** Host cap on a delegated Bot's accepted reply (Q8). consumeMessage checks it too. */
export const BOT_REPLY_MAX_BYTES = 8192;
/** Bound of one canonical metadata line in the Request section, asserted when the line is built. */
export const REPLY_META_MAX_BYTES = 2048;
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

type Publish = (id: string, value: Json) => void;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const cut = (text: string, codePoints: number) => [...text].slice(0, codePoints).join('');

// Unit ledger (§6.2). Each unit moves once: reserved -> spent, or reserved -> released.
function budget(state: CollaborationState, root: string) {
  return state.budgets[root] ??= { continuation: 0, delegation: 0 };
}
function freeUnits(state: CollaborationState, root: string): number {
  const row = budget(state, root);
  return ROOT_BOT_BUDGET - row.delegation - (row.reserved ?? 0);
}
function reserve(state: CollaborationState, root: string, id: string): void {
  if (state.units[id]) return;
  const row = budget(state, root);
  if (freeUnits(state, root) < 1) throw new Error('Root Bot budget invariant: spent + reserved <= 12');
  row.reserved = (row.reserved ?? 0) + 1;
  state.units[id] = { id, root, state: 'reserved' };
}
export function claimUnit(state: CollaborationState, id: string | undefined): void {
  const unit = id === undefined ? undefined : state.units[id];
  if (unit?.state !== 'reserved') return;
  const row = budget(state, unit.root);
  unit.state = 'spent'; row.reserved! -= 1; row.delegation += 1;
}
export function releaseUnit(state: CollaborationState, id: string | undefined): void {
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
function report(state: CollaborationState, batch: Batch, rows: Delegation[], id: string, refusalReport: boolean): void {
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
function deliver(state: CollaborationState, batch: Batch, d?: Delegation): Delegation[] {
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
export function resolveDelegation(state: CollaborationState, d: Delegation, verdict: Verdict, now: number, emit: Publish,
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
export function applyDelegate(state: CollaborationState, turn: Turn, taskId: string, outcome: BotTurnOutcome, seat: boolean,
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
export function observeStart(state: CollaborationState, turn: Turn, now: number, emit: Publish): void {
  claimUnit(state, turn.unit);
  const d = turn.delegationId ? state.delegations[turn.delegationId] : undefined;
  if (!d || d.verdict) return;
  const fresh = d.claimed?.turnId !== turn.id;
  if (fresh) d.claimed = { turnId: turn.id, at: now };
  // A successor that starts after an uncertain claim runs again (§8.3: a later terminal gives the normal verdict).
  if (d.status === 'queued' || fresh && d.status === 'uncertain' && !d.cancel) { d.status = 'running'; publish(d, emit); }
}
/** Display only (§8.3). An uncertain delegation no longer holds back its batch. */
function uncertain(state: CollaborationState, d: Delegation, now: number, emit: Publish): void {
  d.status = 'uncertain'; d.uncertainSince = now; publish(d, emit);
  for (const row of deliver(state, state.batches[d.batch]!)) publish(row, emit);
}
/**
 * Cancel verdict. A reply accepted before the cancel rides along as partial (§8.8).
 * An archived target gives `refused`, and its accepted reply is audit only (§8.4).
 */
function resolveCancel(state: CollaborationState, d: Delegation, taskId: string | undefined, now: number, emit: Publish): void {
  const reply = taskId !== undefined && state.replies[taskId]?.body !== undefined ? taskId : undefined;
  if (d.cancel!.reason === 'target_archived') {
    if (reply) state.audit.push(`Delegation reply after archive: ${d.id} ${reply}`);
    resolveDelegation(state, d, 'refused', now, emit, 'target_archived');
    return;
  }
  if (reply) d.partial = true;
  resolveDelegation(state, d, 'cancelled', now, emit, d.cancel!.reason ?? 'user_cancelled', reply);
}
const CANCELLABLE = new Set<Delegation['status']>(['queued', 'running', 'reply_pending']);
/**
 * Open delegations that a Main Bot can cancel (§8.8): no verdict, no cancel yet,
 * and a state that a cancel can act on. Newest first; the rest are only counted.
 */
export function openDelegations(state: CollaborationState): { items: Delegation[]; omitted: number } {
  const open = Object.values(state.delegations).filter(d => !d.verdict && !d.cancel && CANCELLABLE.has(d.status)).reverse();
  return { items: open.slice(0, OPEN_DELEGATIONS_MAX_ITEMS), omitted: Math.max(0, open.length - OPEN_DELEGATIONS_MAX_ITEMS) };
}
/** ContextPack view of the cancel enum. The enum is never cut without this notice. */
export function openDelegationsContext(state: CollaborationState) {
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
export function arbitrateCancel(s: Pick<LedgerState, 'intents'>, state: CollaborationState, d: Delegation, now: number, emit: Publish,
  reason?: DelegationCancel['reason']): boolean {
  if (d.verdict) throw new Error('Delegation already resolved');
  if (d.cancel) return !d.cancel.delivered;
  if (reason !== 'target_archived' && !CANCELLABLE.has(d.status)) throw new Error('Delegation cannot be cancelled in this state; use abandonDelegation');
  const target = state.turns[d.chainTurnIds.at(-1)!]!, intent = s.intents[hash(target.id)];
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
export function endChain(state: CollaborationState, turn: Turn, taskId: string, proposedSelf: boolean, now: number, emit: Publish): void {
  const d = state.delegations[turn.delegationId!]!;
  if (proposedSelf) d.continuationRefused = true;
  if (state.replies[taskId]?.body !== undefined) { resolveDelegation(state, d, 'answered', now, emit, undefined, taskId); return; }
  Object.assign(d, { status: 'reply_pending', pendingSince: now, nextCheckAt: now, checks: 0 });
  publish(d, emit);
}

/**
 * K4 started flag, or a run terminal, of any generation. A later generation
 * reuses the spent unit. A decline terminal is not a run.
 */
function started(s: LedgerState, key: string): boolean {
  const intent = s.intents[hash(key)];
  return !!intent && Array.from({ length: intent.generation + 1 }, (_, g) => s.executions[taskIdOf(key, g)]).some(execution =>
    execution?.started || execution?.terminal !== undefined && execution.terminal.envelope.type !== 'task.decline');
}
const BUSY = new Set(['agent_home_writer_busy', 'agent_home_reader_busy']);
/** §8.1: K4 conclusion of a chain end that did not succeed -> verdict. */
function failure(s: LedgerState, intent: Intent | undefined, conclusion: Conclusion): { verdict: Verdict; reason?: string } {
  if (conclusion === 'cancelled') {
    // A Host cancel with reason expired: the claim raced the wait deadline (WO-05 ruling).
    return intent?.cancelReason === 'expired' ? { verdict: 'expired', reason: 'claim_raced_deadline' } : { verdict: 'cancelled', reason: 'user_cancelled' };
  }
  if (conclusion === 'expired') return { verdict: 'expired' };
  if (conclusion === 'declined') {
    const envelope = intent && s.executions[intent.taskId]?.terminal?.envelope;
    const code = envelope?.type === 'task.decline' ? envelope.payload.code : undefined;
    return { verdict: 'failed', reason: !code || BUSY.has(code) ? 'busy' : code };
  }
  return { verdict: 'failed' };
}
/** Units, claims, cancels, uncertain states, and verdicts of chain ends that did not succeed. Runs inside sync. */
export function settleDelegations(s: LedgerState, state: CollaborationState, now: number, emit: Publish, timers: DelegationTimers = DEFAULT_TIMERS): void {
  for (const turn of Object.values(state.turns)) {
    if (!turn.unit || state.units[turn.unit]?.state !== 'reserved') continue;
    if (started(s, turn.id)) observeStart(state, turn, now, emit);
    else if (s.intents[hash(turn.id)]?.conclusion || turn.conclusion && !s.intents[hash(turn.id)]) releaseUnit(state, turn.unit);
  }
  for (const d of Object.values(state.delegations)) {
    if (d.lateTurnId && s.intents[hash(d.lateTurnId)]?.conclusion) {
      // A terminal after the verdict is audit only. It never reaches the initiator (§4.3).
      state.audit.push(`Delegation terminal after verdict: ${d.id} ${s.intents[hash(d.lateTurnId)]!.taskId}`);
      delete d.lateTurnId;
    }
    if (d.verdict || !d.chainTurnIds.length) continue;
    const last = state.turns[d.chainTurnIds.at(-1)!]!, intent = s.intents[hash(last.id)];
    if (started(s, last.id)) observeStart(state, last, now, emit);
    // §8.4: archiving the target is a Host cancel of its current chain Turn. deliverCancels sends it.
    if (!d.cancel && state.team.bots[d.toBotId]?.archived) arbitrateCancel(s, state, d, now, emit, 'target_archived');
    if (d.verdict) continue;
    if (d.cancel) {
      const target = state.turns[d.cancel.targetTurnId]!, cancelled = s.intents[hash(target.id)];
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
    const mapped = failure(s, intent, conclusion);
    resolveDelegation(state, d, mapped.verdict, now, emit, mapped.reason);
  }
}
/** "End" (§8.3). An attempt that can still run gets a K4 cancel. Its later terminal goes to audit only. */
export function abandonDelegation(s: LedgerState, state: CollaborationState, d: Delegation, now: number, emit: Publish): boolean {
  if (d.status !== 'reply_held' && d.status !== 'uncertain') throw new Error('Delegation cannot be ended in this state');
  const last = d.chainTurnIds.at(-1)!, intent = s.intents[hash(last)];
  if (intent && !intent.conclusion) {
    d.cancel ??= { requestedAt: now, targetTurnId: last, delivered: false };
    d.lateTurnId = last;
  }
  resolveDelegation(state, d, 'abandoned', now, emit, d.status === 'reply_held' ? 'reply_held' : undefined);
  return !!d.cancel && !d.cancel.delivered;
}
/** Next time a delegation timer can change state without other events. */
export function delegationDue(state: CollaborationState, timers: DelegationTimers): number[] {
  return Object.values(state.delegations).flatMap(d => [
    ...(d.nextCheckAt !== undefined ? [d.nextCheckAt] : []),
    ...(!d.verdict && d.status !== 'uncertain' && d.cancel ? [d.cancel.requestedAt + timers.cancelGraceMs] : []),
    ...(!d.verdict && d.status === 'running' && !d.cancel && d.claimed?.turnId === d.chainTurnIds.at(-1) ? [d.claimed!.at + timers.uncertainAfterMs] : []),
  ]);
}

/** SDK readback for a reply_pending delegation without a Host record (§3.3). */
export function reconcileReply(state: CollaborationState, d: Delegation, readback: { disposition?: { outcome: string } } | undefined,
  now: number, emit: Publish, uncertainAfterMs = REPLY_UNCERTAIN_AFTER_MS): void {
  if (d.verdict || d.nextCheckAt === undefined) return;
  if (!readback || readback.disposition?.outcome === 'refused') { resolveDelegation(state, d, 'failed', now, emit, 'no_reply'); return; }
  if (readback.disposition?.outcome === 'held') {
    d.status = 'reply_held'; delete d.nextCheckAt; publish(d, emit); return;
  }
  // Pending, or accepted without a Host record: the Host alone authors the reply body.
  retryReply(state, d, now, emit, uncertainAfterMs);
}
export function retryReply(state: CollaborationState, d: Delegation, now: number, emit: Publish, uncertainAfterMs = REPLY_UNCERTAIN_AFTER_MS): void {
  d.checks = (d.checks ?? 0) + 1;
  d.nextCheckAt = now + Math.min(REPLY_RETRY_MAX_MS, 1000 * 2 ** (d.checks - 1));
  if (d.status !== 'uncertain' && now - (d.pendingSince ?? now) >= uncertainAfterMs) uncertain(state, d, now, emit);
}

export function frame(label: string, meta: Record<string, unknown>, body: string): string {
  const line = canonical(meta);
  if (bytes(line) > REPLY_META_MAX_BYTES) throw new Error(`Delegation metadata exceeds ${REPLY_META_MAX_BYTES} bytes`);
  return `--- ${label} (${bytes(body)} bytes) ---\n${line}\n${body}\n--- end ${label} ---`;
}
function sender(state: CollaborationState, botId: string) {
  return { botId, name: cut(state.team.bots[botId]?.name ?? '', 40) };
}
/** B's delegation block. It is metadata only: the request text stays in the Request section. */
export function delegationBlock(state: CollaborationState, turn: Turn) {
  const d = state.delegations[turn.delegationId!]!;
  return { delegationId: d.id, from: sender(state, d.fromBotId), hop: d.hop };
}
/**
 * Request section of a Cross-Bot Turn (§3.7). Request text and reply bodies
 * appear once as raw UTF-8 in length-framed blocks, with no second JSON encoding.
 */
export function crossBotRequest(state: CollaborationState, turn: Turn): string {
  if (turn.source === 'bot_request') return frame('request', delegationBlock(state, turn), turn.request);
  return (turn.replies ?? []).map((reply, index) => frame(`reply ${index + 1}`, {
    delegationId: reply.delegationId, from: sender(state, reply.from), request: cut(reply.request, 200), verdict: reply.verdict,
    ...(reply.reason ? { reason: reply.reason } : {}), ...(reply.continuationRefused ? { continuationRefused: true } : {}),
    ...(reply.partial ? { partial: true } : {}),
  }, reply.reply ? state.replies[reply.reply]?.body ?? '' : '')).join('\n');
}

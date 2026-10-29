import { hash } from '@byok-sdk/server/execution-core/canonical';
import { frame } from './frame';

/**
 * Input coalescing as pure rules (#606 R2). Each function changes only the input rows that the caller
 * gives, does no I/O and takes `now` from the caller. The Host gives the facts of each Bot. It adds one
 * user Turn for each returned sealed batch, in the returned order, before any other Turn.
 */
export type Authority = 'owner' | 'bot';
/** One durable record per user input while input coalescing is in use. `key` is the caller's input key. */
export interface UserInput {
  id: string; key: string; botId: string; request: string; bytes: number;
  sender: string; authority: Authority; receivedAt: number; batchId: string;
}
export type SealReason = 'idle' | 'window' | 'items' | 'bytes' | 'boundary' | 'key_changed' | 'cancel' | 'policy_off' | 'archived';
/**
 * `id` is the first input's id and the batch Turn id. `key` is the coalescing key.
 * `request` is the rendered Request while the batch is open; sealing moves it into the batch Turn.
 * `bytes` is its UTF-8 size, framing included. `revision` is the last projected revision: 1 is open, 2 is sealed.
 */
export interface InputBatch {
  id: string; botId: string; key: string; inputIds: string[]; bytes: number;
  openedAt: number; sealAt: number; state: 'open' | 'sealed'; sealReason?: SealReason; request?: string; revision?: 1 | 2;
}
/** Values that apply when `BotOptions.coalesce` is present (owner ruling on #551). */
export const COALESCE_DEFAULTS = { windowMs: 10_000, maxItems: 8, maxBytes: 8192 } as const;
export interface CoalescePolicy { windowMs: number; maxItems: number; maxBytes: number }
export interface InputFields { id: string; key: string; botId: string; request: string; sender: string; authority: Authority }
/** The input rows that the rules read and change. Both maps appear at the first coalesced input. */
export interface CoalesceState { inputs?: Record<string, UserInput>; inputBatches?: Record<string, InputBatch> }
/**
 * Facts of one Bot. `busy`: the Bot has a Turn that is neither concluded nor blocked.
 * `configKey`: the values that identify the Bot configuration; inputs merge only while they stay the same.
 * A Bot without facts counts as archived.
 */
export interface BotFacts { busy: boolean; configKey: readonly string[]; archived: boolean }
/** A sealed batch becomes one user Turn with these fields. Neither changes after this. */
export interface BatchTurn { id: string; botId: string; request: string; authority: Authority; inputIds: string[] }
/**
 * `id` is the Turn that answers the input. With `turn`, the Host adds the input's own Turn with this id,
 * after the Turns of `sealed`. Without it, `id` is a batch id.
 */
export interface Admission { id: string; turn: boolean; sealed: BatchTurn[] }

/** Construction check. `maxBytes` is at most a quarter of the ContextPack budget, so a merged Request always fits it. */
export function coalescePolicy(options: Partial<CoalescePolicy>, contextMaxBytes: number): CoalescePolicy {
  const policy: CoalescePolicy = { windowMs: options.windowMs ?? COALESCE_DEFAULTS.windowMs,
    maxItems: options.maxItems ?? COALESCE_DEFAULTS.maxItems, maxBytes: options.maxBytes ?? COALESCE_DEFAULTS.maxBytes };
  const check = (name: keyof CoalescePolicy, min: number, max: number) => {
    if (!Number.isSafeInteger(policy[name]) || policy[name] < min || policy[name] > max) throw new Error(`coalesce.${name} must be an integer from ${min} to ${max}`);
  };
  check('windowMs', 1000, 60_000);
  check('maxItems', 2, 16);
  check('maxBytes', 1024, Math.floor(contextMaxBytes / 4));
  return policy;
}
/**
 * Inputs merge only when the Bot, conversation, sender, authority and Bot configuration are the same.
 * This reference has one 1:1 conversation per Bot, so the Bot id also identifies the conversation.
 */
function coalesceKey(botId: string, sender: string, authority: Authority, bot: BotFacts): string {
  return hash(['input-batch', botId, sender, authority, ...bot.configKey]);
}
/** A sealed batch is a queued Turn, so its Bot is busy after the seal. */
function busyAfterSeal(bot: BotFacts | undefined): BotFacts | undefined {
  return bot && { ...bot, busy: true };
}
/** One input stays raw text. Several inputs are framed once each, in arrival order, after one notice line. */
export function batchRequest(inputs: readonly UserInput[]): string {
  if (inputs.length === 1) return inputs[0]!.request;
  return [`The owner sent ${inputs.length} messages while you were busy. Read them in order and answer them together.`,
    ...inputs.map((input, index) => frame(`message ${index + 1}/${inputs.length}`, { inputId: input.id, receivedAt: input.receivedAt }, input.request)),
  ].join('\n');
}
/** A Bot has at most one open input batch. */
function openInputBatch(state: CoalesceState, botId: string): InputBatch | undefined {
  return Object.values(state.inputBatches ?? {}).find(batch => batch.botId === botId && batch.state === 'open');
}
function sealInputBatch(state: CoalesceState, batch: InputBatch, reason: SealReason): BatchTurn {
  const request = batch.request;
  if (batch.state !== 'open' || request === undefined) throw new Error('Input batch is already sealed');
  batch.state = 'sealed'; batch.sealReason = reason; delete batch.request;
  return { id: batch.id, botId: batch.botId, request, authority: state.inputs![batch.id]!.authority, inputIds: [...batch.inputIds] };
}
/** Boundary rule: before any other new Turn of a Bot, seal its open batch, so the queue keeps arrival order. */
export function sealAtBoundary(state: CoalesceState, botId: string): BatchTurn | undefined {
  const open = openInputBatch(state, botId);
  return open && sealInputBatch(state, open, 'boundary');
}
function sealIfDue(state: CoalesceState, batch: InputBatch, bot: BotFacts | undefined, policy: CoalescePolicy | undefined, now: number): BatchTurn | undefined {
  const first = state.inputs![batch.id]!;
  const reason: SealReason | undefined = !policy ? 'policy_off' : !bot || bot.archived ? 'archived'
    : coalesceKey(batch.botId, first.sender, first.authority, bot) !== batch.key ? 'key_changed'
    : now >= batch.sealAt ? 'window' : !bot.busy ? 'idle' : undefined;
  return reason && sealInputBatch(state, batch, reason);
}
/** Runs first in each Host sync. The window counts from the first input; later inputs never extend it. */
export function sealDueBatches(state: CoalesceState, bots: Readonly<Record<string, BotFacts>>, policy: CoalescePolicy | undefined, now: number): BatchTurn[] {
  const facts: Record<string, BotFacts | undefined> = { ...bots }, sealed: BatchTurn[] = [];
  for (const batch of Object.values(state.inputBatches ?? {})) {
    if (batch.state !== 'open') continue;
    const turn = sealIfDue(state, batch, facts[batch.botId], policy, now);
    if (turn) { sealed.push(turn); facts[batch.botId] = busyAfterSeal(facts[batch.botId]); }
  }
  return sealed;
}
/**
 * Admit one user input before the Host queues it. `facts.turn` is a Turn that already has the input's id,
 * from a time without coalescing. Without a policy, or with such a Turn, the input keeps its own Turn.
 */
export function admitUserInput(state: CoalesceState, input: InputFields, facts: { bot?: BotFacts; turn?: { request: string } },
  policy: CoalescePolicy | undefined, now: number): Admission {
  const prior = state.inputs?.[input.id];
  if (prior) {
    if (prior.request !== input.request) throw new Error('Input identity conflict');
    return { id: prior.batchId, turn: false, sealed: [] };
  }
  if (facts.turn && facts.turn.request !== input.request) throw new Error('Input identity conflict');
  const sealed: BatchTurn[] = [];
  let bot = facts.bot, open = openInputBatch(state, input.botId);
  const due = open && sealIfDue(state, open, bot, policy, now);
  if (due) { sealed.push(due); bot = busyAfterSeal(bot); open = undefined; }
  if (!policy || facts.turn) return { id: input.id, turn: true, sealed };
  const row: UserInput = { ...input, bytes: Buffer.byteLength(input.request, 'utf8'), receivedAt: now, batchId: input.id };
  const key = coalesceKey(input.botId, input.sender, input.authority, bot!);
  if (open) {
    let reason: SealReason | undefined = open.key !== key ? 'key_changed' : open.inputIds.length >= policy.maxItems ? 'items' : undefined;
    if (!reason) {
      const member = { ...row, batchId: open.id };
      const request = batchRequest([...open.inputIds.map(id => state.inputs![id]!), member]);
      const bytes = Buffer.byteLength(request, 'utf8');
      if (bytes <= policy.maxBytes) {
        state.inputs![member.id] = member;
        open.inputIds.push(member.id); open.request = request; open.bytes = bytes;
        return { id: open.id, turn: false, sealed };
      }
      reason = 'bytes';
    }
    sealed.push(sealInputBatch(state, open, reason)); bot = busyAfterSeal(bot);
  }
  (state.inputs ??= {})[row.id] = row;
  const batch: InputBatch = { id: row.id, botId: row.botId, key, inputIds: [row.id], bytes: row.bytes,
    openedAt: now, sealAt: now + policy.windowMs, state: 'open', request: batchRequest([row]) };
  (state.inputBatches ??= {})[batch.id] = batch;
  // An idle Agent takes the first input at once, with the same Turn id and Request as without coalescing.
  if (!bot!.busy) sealed.push(sealInputBatch(state, batch, 'idle'));
  return { id: batch.id, turn: false, sealed };
}
/** `id` is a batch id or a member input id. An open batch seals first, so the whole batch cancels. */
export function sealBatchForCancel(state: CoalesceState, id: string): { id: string; sealed?: BatchTurn } {
  const input = state.inputs?.[id];
  if (!input) return { id };
  const batch = state.inputBatches![input.batchId]!;
  return batch.state === 'open' ? { id: batch.id, sealed: sealInputBatch(state, batch, 'cancel') } : { id: batch.id };
}

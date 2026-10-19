import { hash } from '@byok-sdk/example-host-execution-core';
import { frame } from './delegation';
import { addTurn, openInputBatch, sealInputBatch, type Authority, type CollaborationState, type InputBatch, type SealReason, type UserInput } from './model';

/** Values that apply when `BotOptions.coalesce` is present (owner ruling on #551). */
export const COALESCE_DEFAULTS = { windowMs: 10_000, maxItems: 8, maxBytes: 8192 } as const;
export interface CoalescePolicy { windowMs: number; maxItems: number; maxBytes: number }
export interface InputFields { id: string; key: string; botId: string; request: string; sender: string; authority: Authority }

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
function coalesceKey(state: CollaborationState, botId: string, sender: string, authority: Authority): string {
  const bot = state.team.bots[botId]!;
  return hash(['input-batch', botId, sender, authority, bot.revision, bot.model]);
}
/** The Bot has a Turn that is neither concluded nor blocked. */
function agentBusy(state: CollaborationState, botId: string): boolean {
  return Object.values(state.turns).some(turn => turn.botId === botId && !turn.conclusion && turn.status !== 'blocked');
}
/** One input stays raw text. Several inputs are framed once each, in arrival order, after one notice line. */
export function batchRequest(inputs: readonly UserInput[]): string {
  if (inputs.length === 1) return inputs[0]!.request;
  return [`The owner sent ${inputs.length} messages while you were busy. Read them in order and answer them together.`,
    ...inputs.map((input, index) => frame(`message ${index + 1}/${inputs.length}`, { inputId: input.id, receivedAt: input.receivedAt }, input.request)),
  ].join('\n');
}

function sealIfDue(state: CollaborationState, batch: InputBatch, policy: CoalescePolicy | undefined, now: number): boolean {
  const bot = state.team.bots[batch.botId], first = state.inputs![batch.id]!;
  const reason: SealReason | undefined = !policy ? 'policy_off' : !bot || bot.archived ? 'archived'
    : coalesceKey(state, batch.botId, first.sender, first.authority) !== batch.key ? 'key_changed'
    : now >= batch.sealAt ? 'window' : !agentBusy(state, batch.botId) ? 'idle' : undefined;
  if (reason) sealInputBatch(state, batch, reason);
  return reason !== undefined;
}
/** Runs first in each Host sync. The window counts from the first input; later inputs never extend it. */
export function sealDueBatches(state: CollaborationState, policy: CoalescePolicy | undefined, now: number): void {
  for (const batch of Object.values(state.inputBatches ?? {})) if (batch.state === 'open') sealIfDue(state, batch, policy, now);
}

/**
 * Admit one user input before K4 enqueue. Returns the id of the Turn that answers it: the batch id.
 * Without a policy, each input keeps its own Turn, as before coalescing.
 */
export function admitUserInput(state: CollaborationState, input: InputFields, policy: CoalescePolicy | undefined, now: number): string {
  const prior = state.inputs?.[input.id];
  if (prior) {
    if (prior.request !== input.request) throw new Error('Input identity conflict');
    return prior.batchId;
  }
  const old = state.turns[input.id];
  if (old && old.request !== input.request) throw new Error('Input identity conflict');
  let open = openInputBatch(state, input.botId);
  if (open && sealIfDue(state, open, policy, now)) open = undefined;
  if (!policy || old) {
    state.budgets[input.id] ??= { continuation: 0, delegation: 0 };
    addTurn(state, { id: input.id, root: input.id, source: 'user', request: input.request, botId: input.botId, hop: 0, authority: input.authority });
    return input.id;
  }
  const row: UserInput = { ...input, bytes: Buffer.byteLength(input.request, 'utf8'), receivedAt: now, batchId: input.id };
  const key = coalesceKey(state, input.botId, input.sender, input.authority);
  if (open) {
    let reason: SealReason | undefined = open.key !== key ? 'key_changed' : open.inputIds.length >= policy.maxItems ? 'items' : undefined;
    if (!reason) {
      const member = { ...row, batchId: open.id };
      const request = batchRequest([...open.inputIds.map(id => state.inputs![id]!), member]);
      const bytes = Buffer.byteLength(request, 'utf8');
      if (bytes <= policy.maxBytes) {
        state.inputs![member.id] = member;
        open.inputIds.push(member.id); open.request = request; open.bytes = bytes;
        return open.id;
      }
      reason = 'bytes';
    }
    sealInputBatch(state, open, reason);
  }
  (state.inputs ??= {})[row.id] = row;
  const batch: InputBatch = { id: row.id, botId: row.botId, key, inputIds: [row.id], bytes: row.bytes,
    openedAt: now, sealAt: now + policy.windowMs, state: 'open', request: batchRequest([row]) };
  (state.inputBatches ??= {})[batch.id] = batch;
  // An idle Agent takes the first input at once, with the same Turn id and Request as without coalescing.
  if (!agentBusy(state, row.botId)) sealInputBatch(state, batch, 'idle');
  return batch.id;
}
/** `cancelTurn` accepts a batch id or a member input id. An open batch seals first, so the whole batch cancels. */
export function sealBatchForCancel(state: CollaborationState, id: string): string {
  const input = state.inputs?.[id];
  if (!input) return id;
  const batch = state.inputBatches![input.batchId]!;
  if (batch.state === 'open') sealInputBatch(state, batch, 'cancel');
  return batch.id;
}

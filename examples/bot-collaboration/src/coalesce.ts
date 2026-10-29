import type { Json } from '@byok-sdk/server/execution-core';
import { addBatchTurns, addTurn, json, type CollaborationState } from './model';
import * as rules from './rules/coalesce';

// K8 adapter for the pure coalescing rules in `rules/coalesce.ts`, and the input batch projection.
export { COALESCE_DEFAULTS, batchRequest, coalescePolicy, type CoalescePolicy, type InputFields } from './rules/coalesce';

/** Bot facts from the team and the Turns. An absent Bot has none. */
function botFacts(state: CollaborationState, botId: string): rules.BotFacts | undefined {
  const bot = state.team.bots[botId];
  return bot && { busy: Object.values(state.turns).some(turn => turn.botId === botId && !turn.conclusion && turn.status !== 'blocked'),
    configKey: [bot.revision, bot.model], archived: bot.archived };
}
/** Runs first in each Host sync. The window counts from the first input; later inputs never extend it. */
export function sealDueBatches(state: CollaborationState, policy: rules.CoalescePolicy | undefined, now: number): void {
  const bots: Record<string, rules.BotFacts> = {};
  for (const batch of Object.values(state.inputBatches ?? {})) {
    const facts = batch.state === 'open' ? botFacts(state, batch.botId) : undefined;
    if (facts) bots[batch.botId] = facts;
  }
  addBatchTurns(state, rules.sealDueBatches(state, bots, policy, now));
}

/**
 * Runs last in each Host sync, so it sees every seal of that pass and of earlier transactions.
 * Revision 1 shows the batch at its first projection while open. A batch that seals before then projects only revision 2.
 */
export function projectInputBatches(state: CollaborationState, emit: (key: string, value: Json) => void): void {
  for (const batch of Object.values(state.inputBatches ?? {})) {
    const revision = batch.state === 'open' ? 1 : 2;
    if ((batch.revision ?? 0) >= revision) continue;
    batch.revision = revision;
    emit(`input-batch:${batch.id}:${revision}`, json({ owner: batch.botId, id: batch.id, revision, state: batch.state, sealReason: batch.sealReason,
      inputIds: batch.inputIds, openedAt: batch.openedAt, sealAt: batch.sealAt }));
  }
}

/**
 * Admit one user input before K4 enqueue. Returns the id of the Turn that answers it: the batch id.
 * Without a policy, each input keeps its own Turn, as before coalescing.
 */
export function admitUserInput(state: CollaborationState, input: rules.InputFields, policy: rules.CoalescePolicy | undefined, now: number): string {
  const admission = rules.admitUserInput(state, input, { bot: botFacts(state, input.botId), turn: state.turns[input.id] }, policy, now);
  addBatchTurns(state, admission.sealed);
  if (admission.turn) {
    state.budgets[input.id] ??= { continuation: 0, delegation: 0 };
    addTurn(state, { id: input.id, root: input.id, source: 'user', request: input.request, botId: input.botId, hop: 0, authority: input.authority });
  }
  return admission.id;
}
/** `cancelTurn` accepts a batch id or a member input id. An open batch seals first, so the whole batch cancels. */
export function sealBatchForCancel(state: CollaborationState, id: string): string {
  const { id: target, sealed } = rules.sealBatchForCancel(state, id);
  if (sealed) addBatchTurns(state, [sealed]);
  return target;
}

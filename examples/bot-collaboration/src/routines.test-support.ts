import type { RoutineScheduleFields } from '@byok-sdk/protocol';
import { hash, type Routine, type RoutineDefinition } from '@byok-sdk/server/execution-core';
import type { BotCollaboration } from './host';
import { botRoutines, createDefinition, type BotRoutine } from './routines';

export const DAILY: RoutineScheduleFields = { minute: 0, hour: 9, tz: 'UTC' };
/** A K4 routine row without a ledger, for schema and ContextPack tests. */
export function routineRow(definition: RoutineDefinition): Routine {
  return { definition: structuredClone(definition), lifecycle: 'active', status: 'ok', next: null };
}
/** The ContextPack views of `count` daily Bot routines of one owner. */
export function routineViews(owner: string, count: number, prompt = 'r'): BotRoutine[] {
  return botRoutines(Array.from({ length: count }, (_, n) => routineRow(createDefinition([], owner, `seed-${n}`, 0,
    { localId: 'new_routine_1', schedule: DAILY, prompt }, 'bot'))));
}
/** Adds a Bot routine of the Main Bot through the K4 core, as an applied `create_routine` action does. Returns its id. */
export async function seedRoutine(bot: BotCollaboration, taskId: string, prompt: string, schedule = DAILY): Promise<string> {
  const definition = createDefinition(Object.values(bot.ledger.snapshot().routines), 'main', taskId, 0,
    { localId: 'new_routine_1', schedule, prompt }, 'bot');
  await bot.core.addRoutine(definition);
  return definition.id;
}
export function routineOf(bot: BotCollaboration, id: string): Routine { return bot.ledger.snapshot().routines[hash(id)]!; }
/** Delivers the reserved wake of a routine, as the SDK does. Returns the delivered reservation. */
export async function deliverRoutine(bot: BotCollaboration, id: string, deliveredAt?: number, delivery = 1) {
  const next = routineOf(bot, id).next!;
  await bot.consume({ wakeId: `delivery:${next.dedupKey}`, dedupKey: next.dedupKey, availableAt: next.availableAt,
    deliveredAt: deliveredAt ?? next.availableAt, delivery }, new AbortController().signal);
  return next;
}

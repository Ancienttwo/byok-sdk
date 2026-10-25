import { expect, it } from 'vitest';
import { commandBots, type Command, type CommandScopeState } from './commands';

/** A plain state slice: two Bots, a room with them and a person, a question and a card of Bot `b`. */
function state(): CommandScopeState {
  return {
    turns: { t: { botId: 'b' }, orphan: { botId: 'gone' } },
    questions: { q: { id: 'q', turnId: 't' }, lost: { id: 'lost', turnId: 'missing' } },
    cards: { c: { turnId: 't' } },
    team: { bots: { a: { archived: false }, b: { archived: false } },
      rooms: { r: { id: 'r', members: ['a', 'person', 'b'] } } },
  } as unknown as CommandScopeState;
}
const mentions = { bots: [] } as never;

it('names the Bots on whose devices each new command would create work', () => {
  const cases: Array<[Command, string[]]> = [
    [{ kind: 'input', botId: 'a', key: 'k', request: 'hi', sender: 'owner' }, ['a']],
    [{ kind: 'receive', inbound: 'owner_input', key: 'k', botId: 'b', request: 'hi', sender: 'owner' }, ['b']],
    // A room input can seat any Bot member; a person is not a Bot.
    [{ kind: 'receive', inbound: 'room_input', key: 'k', roomId: 'r', text: 'hi', mentions, from: 'person' }, ['a', 'b']],
    [{ kind: 'room_input', key: 'k', roomId: 'r', text: 'hi', mentions }, ['a', 'b']],
    // An answer and a decided card add a Turn for the Bot of the question's or card's Turn.
    [{ kind: 'answer', questionId: 'q', answer: 'yes' }, ['b']],
    [{ kind: 'decide', cardId: 'c', decision: 'confirmed' }, ['b']],
  ];
  for (const [command, bots] of cases) expect(commandBots(state(), command), command.kind).toEqual(bots);
});

it('names no Bot for an unknown or prototype id, nor for a command that creates no new work', () => {
  const none: Command[] = [
    { kind: 'input', botId: 'missing', key: 'k', request: 'hi', sender: 'owner' },
    { kind: 'input', botId: '__proto__', key: 'k', request: 'hi', sender: 'owner' },
    { kind: 'room_input', key: 'k', roomId: 'missing', text: 'hi', mentions },
    { kind: 'room_input', key: 'k', roomId: '__proto__', text: 'hi', mentions },
    { kind: 'answer', questionId: 'missing', answer: 'yes' },
    { kind: 'answer', questionId: 'lost', answer: 'yes' },
    { kind: 'answer', questionId: 'constructor', answer: 'yes' },
    { kind: 'decide', cardId: 'missing', decision: 'rejected' },
    { kind: 'decide', cardId: 'toString', decision: 'rejected' },
    { kind: 'outcome', turnId: 't', taskId: 'task', document: {} },
    { kind: 'cancel_turn', turnId: 't' },
    { kind: 'set_main_bot', botId: 'a', mainBot: true },
  ];
  for (const command of none) expect(commandBots(state(), command), JSON.stringify(command)).toEqual([]);
  // A Turn whose Bot is gone names none.
  const slice = state();
  (slice.questions as Record<string, unknown>).q = { id: 'q', turnId: 'orphan' };
  expect(commandBots(slice, { kind: 'answer', questionId: 'q', answer: 'yes' })).toEqual([]);
});

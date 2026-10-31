import { afterEach, expect, it, vi } from 'vitest';
import { openTeam, type TestTeam } from './team.test-support';
import type { BotProfile } from './team-model';

let fixture: TestTeam;
afterEach(async () => { await fixture?.close(); vi.restoreAllMocks(); });
const host = () => fixture.host;
async function running(id: string) {
  let drained = false;
  await vi.waitFor(async () => {
    if (!drained) { await host().drain(); drained = true; }
    expect(fixture.adapter.sessions.has(host().core.intent(id)!.taskId)).toBe(true);
  }, { timeout: 5000 });
  return fixture.adapter.sessions.get(host().core.intent(id)!.taskId)!;
}
async function finish(id: string, document: unknown = {}) {
  (await running(id)).finish(document);
  await vi.waitFor(async () => { await host().drain(); expect(host().snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
}
/** Two ready Bots on the one device of the fixture, so their Agent FIFOs share its slots. */
async function twoBots(): Promise<[BotProfile, BotProfile]> {
  const id = await host().input('create-team', 'Create three Bots');
  await finish(id, { create_bot: [1, 2, 3].map(i => ({ localId: `new_bot_${i}`, name: `Bot ${i}`, role: 'Reviewer', persona: `Persona ${i}`, model: 'default' })) });
  const profiles = Object.values(host().snapshot().team.bots).filter(bot => bot.id !== 'main');
  await vi.waitFor(async () => {
    await host().drain();
    for (const profile of profiles) expect(host().snapshot().team.bots[profile.id]?.readyRevision).toBe(host().snapshot().team.bots[profile.id]?.revision);
  }, { timeout: 5000 });
  return [profiles[0]!, profiles[1]!];
}
const delegationTo = (request: string) => Object.values(host().snapshot().delegations).find(row => row.request === request)!;
/** The Main Bot is in observe by default; its delegation must apply, so the owner switches it to auto first. */
async function mainDelegates(request: string, to: string, key: string) {
  const root = await host().input(key, `Ask ${to}`);
  await finish(root, { delegate: [{ to, request }] });
  return delegationTo(request);
}

it('submits a user intent before the queued bot_request intents of the same Agent FIFO, and keeps submitted work and restart order', async () => {
  fixture = await openTeam();
  const [b] = await twoBots();
  await host().setBotAutonomy('main', 'auto');
  const busy = await host().input('busy', 'Long work', b.id);
  await running(busy);
  const first = await mainDelegates('One', b.id, 'ask-1');
  const second = await mainDelegates('Two', b.id, 'ask-2');
  const head = host().core.intent(busy)!, one = host().core.intent(first.requestTurnId!)!, two = host().core.intent(second.requestTurnId!)!;
  expect(first.requestTurnId).not.toBe(second.requestTurnId);
  expect(head.phase).toBe('inflight');
  expect(one.sequence).toBeLessThan(two.sequence);
  // The owner's message to B arrives after both requests; it becomes the next intent of B's FIFO.
  const urgent = await host().input('urgent', 'Now, please', b.id);
  const user = host().core.intent(urgent)!, firstRequest = host().core.intent(first.requestTurnId!)!, secondRequest = host().core.intent(second.requestTurnId!)!;
  expect(user.sequence).toBeLessThan(firstRequest.sequence);
  expect(firstRequest.sequence).toBeLessThan(secondRequest.sequence);
  // The in-flight execution keeps its sequence, task id and generation.
  expect(host().core.intent(busy)).toMatchObject({ sequence: head.sequence, taskId: head.taskId, generation: 0 });
  // Order comes from the ledger, so a restart keeps it.
  const before = { user: user.sequence, one: firstRequest.sequence, two: secondRequest.sequence };
  await fixture.reopen();
  expect({ user: host().core.intent(urgent)!.sequence, one: host().core.intent(first.requestTurnId!)!.sequence,
    two: host().core.intent(second.requestTurnId!)!.sequence }).toEqual(before);
  await finish(busy);
  await running(urgent);
  expect(fixture.adapter.sessions.has(host().core.intent(first.requestTurnId!)!.taskId)).toBe(false);
  await finish(urgent);
  await running(first.requestTurnId!);
  expect(fixture.adapter.sessions.has(host().core.intent(second.requestTurnId!)!.taskId)).toBe(false);
  await finish(first.requestTurnId!);
  await running(second.requestTurnId!);
  await finish(second.requestTurnId!);
});

// Coalescing is a policy before enqueue: the user's messages have no intent until the batch seals, and a batch seals
// only when its Bot is idle. A queued bot_request keeps the Bot busy, so with coalescing on, the batch follows it.
// The priority rule orders intents; it cannot order an input that is still an open batch. Documented in README.
it('keeps a coalesced batch pending behind queued work, then seals it after that work settles', async () => {
  fixture = await openTeam({ bot: { coalesce: {} } });
  const [b] = await twoBots();
  await host().setBotAutonomy('main', 'auto');
  const busy = await host().input('busy', 'Long work', b.id);
  await running(busy);
  const request = await mainDelegates('One', b.id, 'ask-1');
  const one = await host().input('one', 'First message', b.id);
  const two = await host().input('two', 'Second message', b.id);
  // The busy Bot keeps one open batch; its Turn appears only when the batch seals.
  expect(two).toBe(one);
  expect(host().core.intent(one)).toBeUndefined();
  expect(host().core.intent(request.requestTurnId!)!.phase).toBe('queued');
  await finish(busy);
  // The queued request keeps the Bot busy, so the batch stays open and the request runs first.
  await running(request.requestTurnId!);
  expect(host().core.intent(one)).toBeUndefined();
  await finish(request.requestTurnId!);
  // The Bot is idle now: the batch seals as one Turn and runs, so no input is lost.
  await host().drain();
  await running(one);
  expect(host().snapshot().turns[one]).toMatchObject({ source: 'user' });
  expect(host().snapshot().turns[one]!.inputIds).toHaveLength(2);
  await finish(one);
});

it('reserves one device slot for user work and never cancels a submitted execution to free one', async () => {
  fixture = await openTeam({ bot: { deviceConcurrency: 2 } });
  const [b, c] = await twoBots();
  await host().setBotAutonomy('main', 'auto');
  // B's own work takes one of the two slots.
  const busy = await host().input('busy', 'Long work', b.id);
  await running(busy);
  // C's request is autonomous work: with one slot free and one reserved, it must wait.
  const request = await mainDelegates('Check the totals', c.id, 'ask-c');
  const target = host().core.intent(request.requestTurnId!)!;
  expect(target.phase).toBe('queued');
  expect(fixture.adapter.sessions.has(target.taskId)).toBe(false);
  // User work may take the last slot, and the held request is not cancelled.
  const urgent = await host().input('urgent', 'Now, please', c.id);
  await running(urgent);
  expect(host().core.intent(request.requestTurnId!)!.conclusion).toBeUndefined();
  expect(fixture.adapter.sessions.has(target.taskId)).toBe(false);
  // One slot frees, but the other is still occupied: the autonomous request keeps waiting.
  await finish(urgent);
  await host().drain();
  expect(fixture.adapter.sessions.has(target.taskId)).toBe(false);
  // With the device idle the held request starts; no submitted execution was cancelled.
  await finish(busy);
  await running(request.requestTurnId!);
  await finish(request.requestTurnId!);
});
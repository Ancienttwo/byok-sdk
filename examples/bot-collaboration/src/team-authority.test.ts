import { afterEach, expect, it, vi } from 'vitest';
import type { BotTurnOutcome } from '@byok-sdk/protocol';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { BotCollaboration } from './host';
import { stateOf } from './model';
import { CommitConflict } from './rules/commit';
import { TeamModeError, type TeamSnapshot, type TeamSnapshotBot } from './rules/team';
import type { ContextTurn } from './schema';
import { applyManagement } from './team';
import { openTeam, type TestTeam } from './team.test-support';
import { seedCollaboration } from './commit-vectors.test-support';

let fixture: TestTeam | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

const INJECTED: ContextTurn[] = [
  { id: 'cloud-1', root: 'cloud-1', source: 'user', request: 'Injected request', hop: 0, status: 'succeeded', conclusion: 'succeeded', outcomeSummary: [] },
];
const bot = (id: string, fields: Partial<TeamSnapshotBot> = {}): TeamSnapshotBot =>
  ({ id, name: id, role: 'Helper', persona: `Persona ${id}`, model: 'default', mainBot: false, ...fields });
const MAIN = bot('main', { name: 'Main', role: 'Team owner', mainBot: true });
const snapshot = (revision: number, ...bots: TeamSnapshotBot[]): TeamSnapshot => ({ revision, bots });
/** A snapshot Bot starts with no applied persona. It runs after the daemon reads its projection back. */
async function ready(host: BotCollaboration, ids: string[]) {
  await vi.waitFor(async () => {
    await host.drain();
    const bots = host.snapshot().team.bots;
    expect(ids.every(id => bots[id]?.readyRevision === bots[id]?.revision)).toBe(true);
  }, { timeout: 5000 });
}
async function codeOf(work: Promise<unknown>): Promise<unknown> {
  try { await work; } catch (cause) { return cause instanceof TeamModeError ? cause.code : cause; }
  return 'no error';
}

it('#739 Q4c: runs with an external team and an external history, and keeps no local team', async () => {
  fixture = await openTeam({ bot: { team: 'external', history: async () => INJECTED } });
  const host = fixture.host;
  expect(host.snapshot().team).toMatchObject({ bots: {}, external: { revision: 0 } });
  await host.applyTeam(snapshot(1, MAIN, bot('helper')));
  expect(host.snapshot().team.homeOperations.map(op => op.botId).sort()).toEqual(['helper', 'main']);
  await ready(host, ['main', 'helper']);
  const turnId = await host.input('k1', 'Hello');
  await vi.waitFor(async () => { await host.drain(); expect(host.core.intent(turnId)).toBeDefined(); }, { timeout: 5000 });
  const instruction = host.core.intent(turnId)!.execution.payload.instruction;
  if (typeof instruction !== 'string') throw new Error('Expected an inline instruction');
  expect((JSON.parse(instruction.split('\nContextPack:\n')[1]!) as { turns: unknown[] }).turns).toEqual(INJECTED);
  // T3: the owner Main Bot schema keeps rooms and notes, and offers no Bot management.
  const schema = JSON.stringify(host.snapshot().schemas[turnId]);
  expect(schema).toContain('"create_room"');
  for (const action of ['create_bot', 'update_bot', 'delete_bot']) expect(schema).not.toContain(`"${action}"`);
  const revision = host.snapshot().revision;
  expect(await codeOf(host.setMainBot('helper', true))).toBe('external_team');
  expect(host.snapshot().revision).toBe(revision);
});

it('applies newer team snapshots, replays an applied one and refuses a stale one', async () => {
  fixture = await openTeam({ bot: { team: 'external' } });
  const host = fixture.host;
  await host.applyTeam(snapshot(1, MAIN, bot('helper')));
  await ready(host, ['main', 'helper']);
  const revision = host.snapshot().revision;
  // T5: the same team revision with the same Bots, in any order, replays.
  await host.applyTeam(snapshot(1, bot('helper'), MAIN));
  expect(host.snapshot().revision).toBe(revision);
  await expect(host.applyTeam(snapshot(1, MAIN))).rejects.toThrow(new CommitConflict('identity_conflict', 'Team snapshot identity conflict'));
  // T2, T4: a missing Bot is archived, and a changed persona queues the update_bot projection.
  await host.applyTeam(snapshot(3, { ...MAIN, persona: 'New persona' }));
  expect(host.snapshot().team.bots.helper!.archived).toBe(true);
  expect(host.snapshot().team.bots.main).toMatchObject({ persona: 'New persona', revision: '2', mainBot: true });
  await ready(host, ['main']);
  expect(await codeOf(host.applyTeam(snapshot(2, MAIN)))).toBe('stale_team');
  expect(host.snapshot().team.external).toEqual({ revision: 3 });
});

it('keeps the team mode of a ledger across a restart', async () => {
  fixture = await openTeam({ bot: { team: 'external' } });
  delete fixture.botOptions.team;
  await expect(fixture.reopen()).rejects.toThrow('This ledger has an external team');
  fixture.botOptions.team = 'external';
  await fixture.reopen();
  expect(fixture.host.snapshot().team).toMatchObject({ bots: {}, external: { revision: 0 } });
});

it('refuses the external team mode for a ledger with a local team', async () => {
  fixture = await openTeam();
  fixture.botOptions.team = 'external';
  await expect(fixture.reopen()).rejects.toThrow('This ledger has a local team');
  delete fixture.botOptions.team;
  await fixture.reopen();
  expect(fixture.host.snapshot().team.bots.main).toBeDefined();
});

it('refuses create_bot, update_bot and delete_bot from an outcome in external team mode, and keeps team notes', () => {
  const state = stateOf({}), refused: Record<string, string> = {};
  seedCollaboration(state, 'external');
  const outcome = { create_bot: [{ localId: 'new_bot_1', name: 'New', role: 'Helper', persona: '', model: 'default' }],
    update_bot: [{ botId: 'main', persona: 'Other' }], delete_bot: [{ botId: 'main' }], team_note: { text: 'Note' } } as unknown as BotTurnOutcome;
  applyManagement(state, 'main', 'task-1', outcome, { default: template('device', 'main') }, (kind, work) => {
    try { work(); } catch (cause) { refused[kind] = (cause as Error).message; }
  });
  expect(refused).toEqual(Object.fromEntries(['create_bot', 'update_bot', 'delete_bot'].map(kind => [kind, `external_team: ${kind} is owned by the team authority`])));
  expect(state.team.bots.main).toMatchObject({ archived: false, persona: '', revision: '1' });
  expect(state.team.notes.map(note => note.text)).toEqual(['Note']);
});

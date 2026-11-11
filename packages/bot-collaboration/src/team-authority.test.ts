import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BotTurnOutcome } from '@byok-sdk/protocol';
import { HostLedger, type ExecutionServer, type ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { template } from './k4-fixtures.test-support';
import { BotCollaboration } from './host';
import { botCompactVeto } from './compaction';
import { stateOf } from './model';
import { CommitConflict } from './rules/commit';
import { TeamModeError, type TeamSnapshot, type TeamSnapshotBot } from './rules/team';
import { outcomeSchema, type ContextTurn } from './schema';
import { roomFields } from './rules/rooms';
import { applyManagement } from './team';
import { openTeam, type TestTeam } from './__tests__/team.test-support';
import { seedCollaboration } from './commit-vectors.test-support';

let fixture: TestTeam | undefined;
let persona: { root: string; ledger: HostLedger; host?: BotCollaboration } | undefined;
afterEach(async () => {
  await fixture?.close(); fixture = undefined;
  await persona?.host?.close(); persona?.ledger.close();
  if (persona) rmSync(persona.root, { recursive: true, force: true });
  persona = undefined;
});

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
  expect((JSON.parse(instruction.split('\nContextPack:\n')[1]!) as { history: { recent: unknown[] } }).history.recent).toEqual(INJECTED.map(({ id, root, source, request, hop, status, conclusion, outcomeSummary }) => ({
    lines: [{ speaker: source, text: request }], meta: { id, root, hop, status, conclusion, outcomeSummary } })));
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

/** #1357: Host persona mode on a fake server. No task ever ends, so the first frozen Turn of a Bot stays in flight. */
const FAKE = {
  executions: { submit: async () => ({}) },
  tasks: { offer: async () => undefined, deviceTerminal: async () => undefined, attempt: async () => undefined, cancel: async () => undefined },
  wakes: { pending: async () => [], schedule: async () => undefined, cancel: async () => undefined },
  enqueueAgentHomeProjection: async () => undefined, readAgentHomeProjection: async () => undefined,
} as unknown as ExecutionServer;
const OLD = { ...template('device'), payload: { ...template('device').payload, requiredToolsets: [] } }, NEW = { ...template('other-device'), payload: { ...template('other-device').payload, requiredToolsets: ['docs'] } };
const HOST_MAIN = { ...MAIN, profileRevision: '5' }, HELPER = bot('helper', { model: 'spare', profileRevision: '1' });
function personaHost(models: Record<string, ExecutionTemplate>): BotCollaboration {
  if (!persona) {
    const root = mkdtempSync(join(tmpdir(), 'k8-models-'));
    persona = { root, ledger: new HostLedger(join(root, 'host.sqlite'), 'tenant', { compactVeto: botCompactVeto }) };
  }
  persona.host = undefined;
  return persona.host = new BotCollaboration(FAKE as never, persona.ledger, { botId: 'main', execution: OLD, connector: async () => null,
    team: 'external', persona: 'external', models, readOnlyToolsets: ['docs'] });
}
async function restart(models: Record<string, ExecutionTemplate>): Promise<BotCollaboration> {
  await persona!.host!.close();
  return personaHost(models);
}
const frozen = (host: BotCollaboration, turnId: string) => host.core.intent(turnId)?.execution;
const profile = (host: BotCollaboration, id: string) => { const { execution: _, ...rest } = host.snapshot().team.bots[id]!; return rest; };

it('#1357: setModels re-projects the templates, a later freeze uses them, a frozen Turn keeps its own, and no profile changes', async () => {
  const host = personaHost({ default: OLD });
  await host.applyTeam(snapshot(1, HOST_MAIN));
  await host.personaReady('main', '5');
  const before = profile(host, 'main'), first = await host.input('k1', 'Hello'), queued = await host.input('k2', 'Queued');
  await host.setModels({ default: NEW });
  const later = await host.input('k3', 'Later');
  const agentRef = { agentId: 'main', profileRevision: '5' };
  for (const turnId of [first, queued]) expect(frozen(host, turnId)).toMatchObject({ deviceId: 'device', payload: { agentRef, requiredToolsets: [] } });
  expect(frozen(host, later)).toMatchObject({ deviceId: 'device', payload: { agentRef, requiredToolsets: ['docs'] } });
  expect(profile(host, 'main')).toEqual(before);
  expect(before).toMatchObject({ revision: '5', readyRevision: '5' });
  expect(host.snapshot().team.homeOperations).toEqual([]);
});

it('#1357: refuses setModels with a template outside the read-only toolsets, and changes neither the state nor the models', async () => {
  const host = personaHost({ default: OLD, spare: OLD });
  await host.applyTeam(snapshot(1, HOST_MAIN, HELPER));
  await host.personaReady('helper', '1');
  const before = host.snapshot();
  const bad = { ...OLD, payload: { ...OLD.payload, requiredToolsets: ['write'] } };
  await expect(host.setModels({ default: NEW, other: bad })).rejects.toThrow('not declared read-only by the Host: write');
  expect(host.snapshot()).toEqual(before);
  // The models still name `spare`, so the helper freezes with its old template.
  const turnId = await host.input('k1', 'Hello', 'helper');
  expect(frozen(host, turnId)).toMatchObject({ deviceId: 'device', payload: { requiredToolsets: [] } });
});

it('#1357: a missing template holds only that Bot, a suspended one too, across setModels and a restart, until a call returns it', async () => {
  let host = personaHost({ default: OLD, spare: OLD });
  await host.applyTeam(snapshot(1, HOST_MAIN, HELPER));
  await host.personaReady('main', '5'); await host.personaReady('helper', '1');
  // #1319: a suspended Bot with no template is no reason to refuse setModels or the construction.
  await host.applyTeam(snapshot(2, HOST_MAIN, { ...HELPER, participation: 'suspended' }));
  await host.setModels({ default: OLD });
  host = await restart({ default: NEW });
  expect(host.snapshot().team.bots).toMatchObject({ main: { execution: { deviceId: 'device', payload: { requiredToolsets: ['docs'] } } },
    helper: { execution: { deviceId: 'device', payload: { requiredToolsets: [] } } } });
  await host.applyTeam(snapshot(3, HOST_MAIN, HELPER));
  const held = await host.input('k1', 'Hello', 'helper'), other = await host.input('k2', 'Hello');
  expect(host.snapshot().turns[held]).toMatchObject({ status: 'blocked', blockedReason: 'Unavailable model: spare' });
  expect(frozen(host, held)).toBeUndefined();
  expect(frozen(host, other)).toBeDefined();
  await host.setModels({ default: NEW, spare: NEW });
  expect(frozen(host, held)).toMatchObject({ deviceId: 'device', payload: { agentRef: { agentId: 'helper', profileRevision: '1' }, requiredToolsets: ['docs'] } });
  expect(host.snapshot().turns[held]!.blockedReason).toBeUndefined();
});

it('keeps the external rooms mode of a ledger across a restart (#1321)', async () => {
  fixture = await openTeam({ bot: { team: 'external', rooms: 'external' } });
  expect(fixture.host.snapshot().team.external).toEqual({ revision: 0, rooms: true });
  delete fixture.botOptions.rooms;
  await expect(fixture.reopen()).rejects.toThrow('This ledger has external rooms');
  fixture.botOptions.rooms = 'external';
  await fixture.reopen();
  await fixture.close();
  fixture = await openTeam({ bot: { team: 'external' } });
  fixture.botOptions.rooms = 'external';
  await expect(fixture.reopen()).rejects.toThrow('This ledger has local rooms');
  delete fixture.botOptions.rooms;
  await fixture.reopen();
});

it('refuses create_room and update_room from an outcome in the external rooms mode, and offers neither (#1321)', () => {
  const state = stateOf({}), refused: Record<string, string> = {};
  seedCollaboration(state, 'rooms');
  state.team.rooms.r = { id: 'r', ...roomFields(state.team, { name: 'R', members: ['main'] }), messages: [] };
  const outcome = { create_room: [{ localId: 'new_room_1', name: 'New', members: ['main'] }], update_room: [{ roomId: 'r', name: 'S' }] } as unknown as BotTurnOutcome;
  applyManagement(state, 'main', 'task-1', outcome, { default: template('device', 'main') }, (kind, work) => {
    try { work(); } catch (cause) { refused[kind] = (cause as Error).message; }
  });
  expect(refused).toEqual(Object.fromEntries(['create_room', 'update_room'].map(kind => [kind, `external_rooms: ${kind} is owned by the team authority`])));
  expect(Object.values(state.team.rooms).map(room => room.name)).toEqual(['R']);
  const schema = JSON.stringify(outcomeSchema('main', state, state.turns.t1));
  expect(schema).toContain('"team_note"');
  for (const action of ['create_room', 'update_room']) expect(schema).not.toContain(`"${action}"`);
});

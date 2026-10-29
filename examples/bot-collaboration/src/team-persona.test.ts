import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HostLedger, type ExecutionServer } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type BotOptions } from './host';
import { botCompactVeto } from './compaction';
import { TeamModeError, type TeamSnapshotBot } from './rules/team';

/**
 * #879: in Host persona mode the Host projects each Bot's Agent home. The fake server records every projection call
 * and every submitted execution. No task ever ends, so a frozen Turn stays in flight.
 */
const calls: string[] = [];
const submitted: Array<{ agentRef: { agentId: string; profileRevision: string } }> = [];
const server = {
  executions: { submit: async (input: { payload: { agentRef: { agentId: string; profileRevision: string } } }) => { submitted.push(input.payload); return {}; } },
  tasks: { offer: async () => undefined, deviceTerminal: async () => undefined, attempt: async () => undefined, cancel: async () => undefined },
  wakes: { pending: async () => [], schedule: async () => undefined, cancel: async () => undefined },
  enqueueAgentHomeProjection: async () => { calls.push('enqueue'); },
  readAgentHomeProjection: async () => { calls.push('read'); return undefined; },
} as unknown as ExecutionServer;

let root: string | undefined, ledger: HostLedger | undefined, bot: BotCollaboration | undefined;
afterEach(async () => {
  await bot?.close(); ledger?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = ledger = bot = undefined;
  calls.length = 0; submitted.length = 0;
});
function open(options: Partial<BotOptions> = { team: 'external', persona: 'external' }): BotCollaboration {
  root ??= mkdtempSync(join(tmpdir(), 'k8-persona-'));
  ledger ??= new HostLedger(join(root, 'host.sqlite'), 'tenant', { compactVeto: botCompactVeto });
  return new BotCollaboration(server as never, ledger, { botId: 'main', execution: template('device'), connector: async () => null, ...options });
}
const MAIN = (profileRevision?: string, persona = 'Main persona'): TeamSnapshotBot => ({ id: 'main', name: 'Main', role: 'Team owner', persona,
  model: 'default', mainBot: true, ...(profileRevision === undefined ? {} : { profileRevision }) });
const MEMBER = (id: string, profileRevision: string, persona = `${id} persona`): TeamSnapshotBot => ({ id, name: id, role: 'Member', persona,
  model: 'default', mainBot: false, profileRevision });
const frozen = (turnId: string) => bot!.core.intent(turnId)?.execution.payload.agentRef;
const submittedRefs = () => submitted.map(payload => payload.agentRef);

it('freezes a Turn only after the Host reports its profile revision, and queues no projection', async () => {
  bot = open();
  await bot.applyTeam({ revision: 1, bots: [MAIN('5')] });
  expect(bot.snapshot().team).toMatchObject({ external: { revision: 1, persona: true }, homeOperations: [],
    bots: { main: { revision: '5', readyRevision: null, execution: { payload: { agentRef: { agentId: 'main', profileRevision: '5' } } } } } });
  const first = await bot.input('k1', 'Hello');
  expect(frozen(first)).toBeUndefined();
  expect(submitted).toEqual([]);
  await bot.personaReady('main', '5');
  expect(frozen(first)).toEqual({ agentId: 'main', profileRevision: '5' });
  expect(submittedRefs()).toEqual([{ agentId: 'main', profileRevision: '5' }]);
  expect(calls).toEqual([]);
});

it('waits for the new revision, and an older report does not ready it', async () => {
  bot = open();
  await bot.applyTeam({ revision: 1, bots: [MAIN('5')] });
  await bot.personaReady('main', '5');
  await bot.applyTeam({ revision: 2, bots: [MAIN('6', 'New persona')] });
  // The Bot keeps its last ready revision, so it stays a delegate target, and its Turns wait.
  expect(bot.snapshot().team.bots.main).toMatchObject({ revision: '6', readyRevision: '5', persona: 'New persona' });
  const turnId = await bot.input('k1', 'Hello');
  await bot.personaReady('main', '5');
  expect(frozen(turnId)).toBeUndefined();
  expect(submitted).toEqual([]);
  await expect(bot.personaReady('main', '7')).rejects.toThrow('Profile revision 7 is newer than the Bot revision 6');
  await bot.personaReady('main', '6');
  expect(frozen(turnId)).toEqual({ agentId: 'main', profileRevision: '6' });
  expect(submittedRefs()).toEqual([{ agentId: 'main', profileRevision: '6' }]);
  expect(calls).toEqual([]);
});

it('keeps the ready revision across a restart', async () => {
  bot = open();
  await bot.applyTeam({ revision: 1, bots: [MAIN('5')] });
  await bot.personaReady('main', '5');
  await bot.close(); ledger!.close(); bot = ledger = undefined;
  bot = open();
  expect(bot.snapshot().team.bots.main).toMatchObject({ revision: '5', readyRevision: '5' });
  const turnId = await bot.input('k1', 'Hello');
  expect(frozen(turnId)).toEqual({ agentId: 'main', profileRevision: '5' });
});

it('refuses personaReady for a Bot that a snapshot dropped, or that never existed', async () => {
  bot = open();
  await bot.applyTeam({ revision: 1, bots: [MAIN('5'), MEMBER('other', '1')] });
  await bot.applyTeam({ revision: 2, bots: [MAIN('5')] });
  expect(bot.snapshot().team.bots.other).toMatchObject({ archived: true, readyRevision: null });
  await expect(bot.personaReady('other', '1')).rejects.toThrow('Bot is archived or absent');
  await expect(bot.personaReady('ghost', '1')).rejects.toThrow('Bot is archived or absent');
  expect(bot.snapshot().team.bots.other).toMatchObject({ archived: true, readyRevision: null });
});

it('refuses a multi-Bot snapshot at a later Bot, and leaves earlier and archived Bots as before', async () => {
  bot = open();
  await bot.applyTeam({ revision: 1, bots: [MEMBER('alpha', '1'), MEMBER('beta', '1'), MEMBER('carol', '1'), MAIN('5')] });
  await bot.applyTeam({ revision: 2, bots: [MEMBER('alpha', '1'), MEMBER('carol', '1'), MAIN('5')] });
  const before = bot.snapshot();
  expect(before.team.bots.beta!.archived).toBe(true);
  // `alpha` sorts before `main`, so it is written first. `carol` is absent, so it would be archived too.
  await expect(bot.applyTeam({ revision: 3, bots: [MEMBER('alpha', '2', 'New persona'), MAIN('4')] })).rejects.toThrow('Profile revision 4 of main is older than 5');
  expect(bot.snapshot()).toEqual(before);
  expect(bot.snapshot().team.bots).toMatchObject({ alpha: { revision: '1', persona: 'alpha persona' }, beta: { archived: true }, carol: { archived: false } });
});

it.each<[string, TeamSnapshotBot[], string]>([
  ['a Bot without a profile revision', [MAIN()], 'Each snapshot Bot needs a profileRevision in the Host persona mode'],
  ['a revision that goes back', [MAIN('4')], 'Profile revision 4 of main is older than 5'],
  ['a profile change at the same revision', [MAIN('5', 'Changed')], 'A profile change of main needs a newer profile revision'],
  ['a revision that is not canonical', [MAIN('05')], 'Invalid profile revision'],
  ['a revision of 0, which the protocol refuses', [MAIN('0')], 'Invalid profile revision'],
])('refuses a snapshot with %s, and changes nothing', async (_name, bots, message) => {
  bot = open();
  await bot.applyTeam({ revision: 1, bots: [MAIN('5')] });
  const before = bot.snapshot();
  await expect(bot.applyTeam({ revision: 2, bots })).rejects.toThrow(message);
  expect(bot.snapshot()).toEqual(before);
});

it('refuses a persona_ready report of revision 0, and changes nothing', async () => {
  bot = open();
  await bot.applyTeam({ revision: 1, bots: [MAIN('5')] });
  const before = bot.snapshot();
  await expect(bot.personaReady('main', '0')).rejects.toThrow('Invalid profile revision');
  expect(bot.snapshot().team).toEqual(before.team);
});

it('refuses retryPersona, and a ledger keeps its persona mode', async () => {
  bot = open();
  await bot.applyTeam({ revision: 1, bots: [MAIN('5')] });
  await expect(bot.retryPersona('main')).rejects.toMatchObject({ code: 'external_persona' });
  await expect(bot.retryPersona('main')).rejects.toBeInstanceOf(TeamModeError);
  await bot.close(); bot = undefined;
  expect(() => open({ team: 'external' })).toThrow('This ledger has Host persona projections');
  bot = open();
  expect(bot.snapshot().team.external).toEqual({ revision: 1, persona: true });
});

it('keeps the K8 persona mode without the option, and refuses the option without an external team', async () => {
  expect(() => open({ persona: 'external' })).toThrow("The Host persona mode needs team: 'external'");
  bot = open({ team: 'external' });
  await expect(bot.applyTeam({ revision: 1, bots: [MAIN('5')] })).rejects.toThrow('profileRevision needs the Host persona mode');
  await expect(bot.personaReady('main', '1')).rejects.toThrow('persona_ready needs the Host persona mode');
  await bot.applyTeam({ revision: 1, bots: [MAIN()] });
  expect(bot.snapshot().team.bots.main).toMatchObject({ revision: '1', readyRevision: null });
  expect(bot.snapshot().team.homeOperations.map(op => op.request.payload.agentRef)).toEqual([{ agentId: 'main', profileRevision: '1' }]);
  await bot.close(); bot = undefined;
  expect(() => open()).toThrow('This ledger has K8 persona projections');
});

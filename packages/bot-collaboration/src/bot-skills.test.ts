import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { SkillId } from '@byok-sdk/protocol';
import { HostLedger, type ExecutionServer, type ExecutionTemplate } from '@byok-sdk/server/execution-core';
import { botLedgerOptions, K8_FORMAT } from './compaction';
import { BotCollaboration, type BotOptions } from './host';
import { template } from './k4-fixtures.test-support';
import { stateOf } from './model';
import { teamSnapshot, withBotSkills, type TeamSnapshotBot } from './rules/team';
import { applyModels, updateBot } from './team';

const FAKE_SERVER = {
  executions: { submit: async () => ({}) },
  tasks: { offer: async () => undefined, deviceTerminal: async () => undefined, attempt: async () => undefined, cancel: async () => undefined },
  wakes: { pending: async () => [], schedule: async () => undefined, cancel: async () => undefined },
  enqueueAgentHomeProjection: async () => undefined,
  readAgentHomeProjection: async () => undefined,
} as unknown as ExecutionServer;

let root: string | undefined;
let ledger: HostLedger | undefined;
let host: BotCollaboration | undefined;

afterEach(async () => {
  await host?.close();
  ledger?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = ledger = host = undefined;
});

function withTemplateSkills(skills?: readonly SkillId[], deviceId = 'device'): ExecutionTemplate {
  const base = template(deviceId);
  return skills ? { ...base, payload: { ...base.payload, requiredSkills: [...skills] } } : base;
}

function openHost(models: Record<string, ExecutionTemplate>, options: Partial<BotOptions> = {}): BotCollaboration {
  root ??= mkdtempSync(join(tmpdir(), 'k8-bot-skills-'));
  ledger ??= new HostLedger(join(root, 'host.sqlite'), 'tenant', botLedgerOptions);
  host = new BotCollaboration(FAKE_SERVER, ledger, {
    botId: 'main',
    execution: models.default ?? template('device'),
    models,
    connector: async () => null,
    team: 'external',
    persona: 'external',
    ...options,
  });
  return host;
}

const botRow = (id: string, overrides: Partial<TeamSnapshotBot> = {}): TeamSnapshotBot => ({
  id, name: id, role: 'Helper', persona: `Persona ${id}`, model: 'default', mainBot: id === 'main',
  ...overrides,
});

const frozenSkills = (turnId: string) => host!.core.intent(turnId)?.execution.payload.requiredSkills;

it('carries TeamSnapshotBot.skills onto BotProfile.skills and frozen Turn offers with template-first deduplicated union', async () => {
  openHost({ default: withTemplateSkills(['base', 'shared']) });
  await host!.applyTeam({
    revision: 1,
    bots: [botRow('main', { profileRevision: '1', skills: ['shared', 'extra'] })],
  });
  await host!.personaReady('main', '1');

  expect(host!.snapshot().team.bots.main!.skills).toEqual(['shared', 'extra']);
  expect(host!.snapshot().team.bots.main!.execution.payload.requiredSkills).toEqual(['base', 'shared', 'extra']);

  const first = await host!.input('k1', 'Run with skills');
  expect(frozenSkills(first)).toEqual(['base', 'shared', 'extra']);

  // Clearing Bot skills keeps the model template's own requiredSkills on the next Turn, while the earlier frozen Turn stays unchanged.
  await host!.applyTeam({
    revision: 2,
    bots: [botRow('main', { profileRevision: '2', skills: [] })],
  });
  await host!.personaReady('main', '2');
  expect(host!.snapshot().team.bots.main!.skills).toBeUndefined();
  expect(host!.snapshot().team.bots.main!.execution.payload.requiredSkills).toEqual(['base', 'shared']);

  const second = await host!.input('k2', 'Run after clearing bot skills');
  expect(frozenSkills(first)).toEqual(['base', 'shared', 'extra']);
  expect(frozenSkills(second)).toEqual(['base', 'shared']);
});

it('omits requiredSkills when the merged union is empty and normalizes [] identically to omitted', async () => {
  openHost({ default: withTemplateSkills() });
  await host!.applyTeam({
    revision: 1,
    bots: [botRow('main', { profileRevision: '1', skills: ['review'] })],
  });
  await host!.personaReady('main', '1');
  const withSkill = await host!.input('k1', 'With skill');
  expect(frozenSkills(withSkill)).toEqual(['review']);

  // Clearing with [] omits both BotProfile.skills and execution.payload.requiredSkills.
  await host!.applyTeam({
    revision: 2,
    bots: [botRow('main', { profileRevision: '2', skills: [] })],
  });
  await host!.personaReady('main', '2');
  const cleared = host!.snapshot().team.bots.main!;
  expect('skills' in cleared).toBe(false);
  expect('requiredSkills' in cleared.execution.payload).toBe(false);

  const withoutSkill = await host!.input('k2', 'Without skill');
  expect('requiredSkills' in host!.core.intent(withoutSkill)!.execution.payload).toBe(false);

  // Replaying revision 2 with skills omitted matches the normalized [] evidence cleanly.
  const revBefore = host!.snapshot().revision;
  await host!.applyTeam({
    revision: 2,
    bots: [botRow('main', { profileRevision: '2' })],
  });
  expect(host!.snapshot().revision).toBe(revBefore);
});

it('applyModels and setModels preserve Bot skills onto refreshed templates and reject >16 combined atomically', async () => {
  openHost({ default: withTemplateSkills(['base.v1']) });
  await host!.applyTeam({
    revision: 1,
    bots: [botRow('main', { profileRevision: '1', skills: ['review', 'lint'] })],
  });
  await host!.personaReady('main', '1');

  // Refreshing templates without requiredSkills must never wipe per-Bot skills.
  await host!.setModels({ default: withTemplateSkills() });
  expect(host!.snapshot().team.bots.main!.execution.payload.requiredSkills).toEqual(['review', 'lint']);

  // Refreshing templates with new template skills merges template-first with Bot skills.
  await host!.setModels({ default: withTemplateSkills(['base.v2', 'review']) });
  expect(host!.snapshot().team.bots.main!.execution.payload.requiredSkills).toEqual(['base.v2', 'review', 'lint']);

  // Refusal above 16 combined skills leaves both ledger state and active models unchanged.
  const before = host!.snapshot();
  const fifteen = Array.from({ length: 15 }, (_, i) => `tpl-${i}` as SkillId);
  await expect(host!.setModels({ default: withTemplateSkills(fifteen) })).rejects.toThrow('requiredSkills');
  expect(host!.snapshot()).toEqual(before);

  // Direct applyModels with multiple Bots is atomic when a later Bot exceeds 16.
  const state = stateOf({});
  state.team.bots = {
    a: {
      id: 'a', name: 'A', role: 'r', persona: 'p', model: 'm1', mainBot: false, archived: false,
      revision: '1', readyRevision: '1', skills: ['alpha'], execution: withTemplateSkills(['old-a']),
    },
    b: {
      id: 'b', name: 'B', role: 'r', persona: 'p', model: 'm2', mainBot: false, archived: false,
      revision: '1', readyRevision: '1', skills: ['s1', 's2'], execution: withTemplateSkills(['old-b']),
    },
  };
  expect(() => applyModels(state, { m1: withTemplateSkills(['new-a']), m2: withTemplateSkills(fifteen) }, [])).toThrow('requiredSkills');
  expect(state.team.bots.a!.execution.payload.requiredSkills).toEqual(['old-a']);
  expect(state.team.bots.b!.execution.payload.requiredSkills).toEqual(['old-b']);
});

it('updateBot preserves existing Bot skills when model or persona updates', () => {
  const state = stateOf({});
  state.team.bots.main = {
    id: 'main', name: 'Main', role: 'Owner', persona: 'p1', model: 'm1', mainBot: true, archived: false,
    revision: '1', readyRevision: '1', skills: ['shared', 'extra'], execution: withTemplateSkills(['base-a', 'shared']),
  };
  const models = {
    m1: withTemplateSkills(['base-a', 'shared']),
    m2: withTemplateSkills(['base-b', 'shared']),
  };

  updateBot(state, { botId: 'main', persona: 'p2' }, models);
  expect(state.team.bots.main!.skills).toEqual(['shared', 'extra']);
  expect(state.team.bots.main!.execution.payload.requiredSkills).toEqual(['base-a', 'shared', 'extra']);

  updateBot(state, { botId: 'main', model: 'm2' }, models);
  expect(state.team.bots.main!.skills).toEqual(['shared', 'extra']);
  expect(state.team.bots.main!.execution.payload.requiredSkills).toEqual(['base-b', 'shared', 'extra']);
});

it('updates skills in K8 persona mode and enforces newer profileRevision in Host persona mode', async () => {
  // Host persona mode: changing skills at the same profileRevision refuses without mutating state.
  openHost({ default: withTemplateSkills() });
  await host!.applyTeam({
    revision: 1,
    bots: [botRow('main', { profileRevision: '5', skills: ['review'] })],
  });
  const before = host!.snapshot();
  await expect(host!.applyTeam({
    revision: 2,
    bots: [botRow('main', { profileRevision: '5', skills: ['lint'] })],
  })).rejects.toThrow('A profile change of main needs a newer profile revision');
  expect(host!.snapshot()).toEqual(before);

  await host!.applyTeam({
    revision: 2,
    bots: [botRow('main', { profileRevision: '6', skills: ['lint'] })],
  });
  expect(host!.snapshot().team.bots.main).toMatchObject({ revision: '6', skills: ['lint'] });
  expect(host!.snapshot().team.bots.main!.execution.payload.requiredSkills).toEqual(['lint']);

  // K8 persona mode: changing only skills bumps revision, updates execution, and queues persona projection.
  await host!.close(); ledger!.close(); rmSync(root!, { recursive: true, force: true });
  root = ledger = host = undefined;
  openHost({ default: withTemplateSkills(['base']) }, { persona: undefined });
  await host!.applyTeam({
    revision: 1,
    bots: [botRow('main', { skills: ['review'] })],
  });
  expect(host!.snapshot().team.bots.main).toMatchObject({ revision: '1', skills: ['review'] });
  expect(host!.snapshot().team.bots.main!.execution.payload.requiredSkills).toEqual(['base', 'review']);

  await host!.applyTeam({
    revision: 2,
    bots: [botRow('main', { skills: ['lint'] })],
  });
  expect(host!.snapshot().team.bots.main).toMatchObject({ revision: '2', skills: ['lint'] });
  expect(host!.snapshot().team.bots.main!.execution.payload.requiredSkills).toEqual(['base', 'lint']);
});

it('clearing Bot skills while its model template is temporarily missing keeps the unavailable-model gate and never leaks old Bot skills after restore', async () => {
  openHost({ default: withTemplateSkills(), spare: withTemplateSkills(['base', 'shared']) });
  await host!.applyTeam({
    revision: 1,
    bots: [
      botRow('main', { profileRevision: '1' }),
      botRow('helper', { model: 'spare', profileRevision: '1', skills: ['shared', 'extra'] }),
    ],
  });
  await host!.personaReady('helper', '1');
  expect(host!.snapshot().team.bots.helper!.execution.payload.requiredSkills).toEqual(['base', 'shared', 'extra']);

  // Temporarily remove the `spare` template.
  await host!.setModels({ default: withTemplateSkills() });

  // Clear `helper`'s skills while `spare` is missing.
  await host!.applyTeam({
    revision: 2,
    bots: [
      botRow('main', { profileRevision: '1' }),
      botRow('helper', { model: 'spare', profileRevision: '2', skills: [] }),
    ],
  });
  await host!.personaReady('helper', '2');
  expect(host!.snapshot().team.bots.helper!.skills).toBeUndefined();

  // Existing unavailable-model gate holds the Turn; nothing freezes while `spare` is absent.
  const held = await host!.input('k-held', 'Wait for template', 'helper');
  expect(host!.snapshot().turns[held]).toMatchObject({ status: 'blocked', blockedReason: 'Unavailable model: spare' });
  expect(host!.core.intent(held)).toBeUndefined();

  // Restoring `spare` rebuilds from the raw template and freezes without `extra`.
  await host!.setModels({ default: withTemplateSkills(), spare: withTemplateSkills(['base', 'shared']) });
  expect(host!.snapshot().turns[held]!.blockedReason).toBeUndefined();
  expect(frozenSkills(held)).toEqual(['base', 'shared']);
});

it('rejects invalid, non-array, duplicate, and >16 skill ids at teamSnapshot before any commit', async () => {
  const seventeen = Array.from({ length: 17 }, (_, i) => `skill-${i}` as SkillId);
  const cases: Array<[string, unknown]> = [
    ['non-array string', 'review'],
    ['non-array object', { review: true }],
    ['uppercase skill id', ['Review']],
    ['path traversal skill id', ['../escape']],
    ['duplicate skill ids', ['review', 'review']],
    ['more than 16 skill ids', seventeen],
  ];
  for (const [label, skills] of cases) {
    expect(() => teamSnapshot({ revision: 1, bots: [botRow('main', { skills: skills as never })] }), label).toThrow('Invalid team snapshot Bot skills');
  }

  openHost({ default: withTemplateSkills() });
  await host!.applyTeam({ revision: 1, bots: [botRow('main', { profileRevision: '1', skills: ['review'] })] });
  const before = host!.snapshot();
  await expect(host!.applyTeam({ revision: 2, bots: [botRow('main', { profileRevision: '2', skills: ['Bad_Id' as SkillId] })] })).rejects.toThrow('Invalid team snapshot Bot skills');
  expect(host!.snapshot()).toEqual(before);

  // withBotSkills accepts 16 combined unique ids (with overlap) and rejects 17.
  const ten = Array.from({ length: 10 }, (_, i) => `skill-${i}` as SkillId);
  const eightWithTwoOverlap = ['skill-8', 'skill-9', ...Array.from({ length: 6 }, (_, i) => `extra-${i}`)] as SkillId[];
  expect(withBotSkills(withTemplateSkills(ten), eightWithTwoOverlap).payload.requiredSkills).toHaveLength(16);
  const sevenDistinct = Array.from({ length: 7 }, (_, i) => `extra-${i}` as SkillId);
  expect(() => withBotSkills(withTemplateSkills(ten), sevenDistinct)).toThrow('requiredSkills');
});

it('replays existing persisted Bot rows without skills cleanly at the same K8_FORMAT and preserves persisted skills across restart', async () => {
  expect(K8_FORMAT).toBe(3);
  openHost({ default: withTemplateSkills(['base']) });
  await host!.applyTeam({
    revision: 1,
    bots: [
      botRow('main', { profileRevision: '1' }),
      botRow('helper', { profileRevision: '1', skills: ['review'] }),
    ],
  });
  await host!.personaReady('main', '1');
  await host!.personaReady('helper', '1');

  // Simulate a pre-skills persisted ledger row with no `skills` field on `main`.
  ledger!.transaction(s => {
    delete stateOf(s.application).team.bots.main!.skills;
  });
  await host!.close();
  ledger!.close();
  host = ledger = undefined;

  openHost({ default: withTemplateSkills(['base']) });
  expect(host!.snapshot().team.bots.main!.skills).toBeUndefined();
  expect(host!.snapshot().team.bots.main!.execution.payload.requiredSkills).toEqual(['base']);
  expect(host!.snapshot().team.bots.helper!.skills).toEqual(['review']);
  expect(host!.snapshot().team.bots.helper!.execution.payload.requiredSkills).toEqual(['base', 'review']);

  const tMain = await host!.input('k-main', 'Main turn', 'main');
  const tHelper = await host!.input('k-helper', 'Helper turn', 'helper');
  expect(frozenSkills(tMain)).toEqual(['base']);
  expect(frozenSkills(tHelper)).toEqual(['base', 'review']);
});
